// Local QA of 20261017231500_latest_unseen_first.sql on an embedded Postgres:
// the latest order puts links the caller has seen (visited, or had on screen)
// at or before as_of below the unseen ones, scoped to the caller by RLS, and
// leaves the other orders alone.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { readFileSync } from "node:fs";

const [migration] = process.argv.slice(2);
const db = new PGlite({ extensions: { ltree } });

await db.exec(`
create extension ltree;
create schema extensions;
create schema auth;
create role anon; create role authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
create table public.profiles (id uuid primary key);
create table public.links (id uuid primary key, search_text text not null default '', created_at timestamptz not null);
create table public.link_entities (link_id uuid, entity_id uuid);
create table public.link_topics (link_id uuid, topic_id ltree);
create table public.votes (link_id uuid, voter_id uuid, value int);
create table public.replies (link_id uuid);
create table public.link_visits (
  id uuid primary key default gen_random_uuid(), link_id uuid references links(id), visitor_id uuid references profiles(id),
  visited_at timestamptz not null default now(), unique (link_id, visitor_id));
alter table public.link_visits enable row level security;
create policy own on public.link_visits for select to authenticated using (auth.uid() = visitor_id);
create function public.fold_text(t text) returns text language sql immutable as $$ select lower(t) $$;
create function public.link_search_hits(search text) returns table (link_id uuid, score real) language sql stable as $$
  select id, 1::real from links where search_text ilike '%' || search || '%' $$;
create function public.ranked_feed(as_of timestamptz, page_offset int, page_size int)
  returns table (link_id uuid, rank double precision) language sql stable as $$
  select id, extract(epoch from created_at)::double precision from links $$;
grant usage on schema public to authenticated, anon;
grant select on all tables in schema public to authenticated, anon;
insert into profiles values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
insert into links (id, created_at) select ('00000000-0000-0000-0000-00000000000' || i)::uuid, '2026-10-17 12:00'::timestamptz - make_interval(hours => i)
  from generate_series(1, 6) i;
`);
await db.exec(readFileSync(migration, "utf8"));

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const L = (i) => `00000000-0000-0000-0000-00000000000${i}`;
// A clicked link 2 and had links 1 and 4 on screen before as_of, and saw 3
// after it; B had link 5 on screen.
await db.exec(`
insert into link_visits (link_id, visitor_id, visited_at) values ('${L(2)}', '${A}', '2026-10-17 12:30');
insert into link_impressions (viewer_id, link_id, seen_at) values
  ('${A}', '${L(1)}', '2026-10-17 12:30'), ('${A}', '${L(4)}', '2026-10-17 12:40'),
  ('${A}', '${L(3)}', '2026-10-17 14:00'), ('${B}', '${L(5)}', '2026-10-17 12:30');
`);

const AS_OF = "2026-10-17 13:00";
const asUser = async (uid, sql, params = []) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role;");
  }
};
const page = async (uid, sort, offset = 0, size = 30) =>
  (await asUser(uid, `select link_id from feed_query($1, null, null, $2, $3, $4)`, [sort, AS_OF, offset, size]))
    .map((r) => Number(r.link_id.slice(-1)));

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

check("A: unseen newest first, then what A saw before as_of", await page(A, "latest"), [3, 5, 6, 1, 2, 4]);
check("B: only B's own impression counts", await page(B, "latest"), [1, 2, 3, 4, 6, 5]);
check("no session: plain newest first", await page(null, "latest"), [1, 2, 3, 4, 5, 6]);
check("pages of 2 join up to the whole order",
  [...await page(A, "latest", 0, 2), ...await page(A, "latest", 2, 2), ...await page(A, "latest", 4, 2)], [3, 5, 6, 1, 2, 4]);
check("for_you is unchanged", await page(A, "for_you"), [1, 2, 3, 4, 5, 6]);
check("A reads only A's impressions", (await asUser(A, "select count(*)::int n from link_impressions"))[0].n, 3);
let refused = false;
try {
  await asUser(A, `insert into link_impressions (viewer_id, link_id) values ('${B}', '${L(6)}')`);
} catch {
  refused = true;
}
check("A can't record an impression as B", refused, true);
await asUser(A, `insert into link_impressions (viewer_id, link_id) values ('${A}', '${L(6)}') on conflict do nothing`);
await asUser(A, `insert into link_impressions (viewer_id, link_id) values ('${A}', '${L(6)}') on conflict do nothing`);
check("A records its own, a repeat is a no-op", (await asUser(A, "select count(*)::int n from link_impressions"))[0].n, 4);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
