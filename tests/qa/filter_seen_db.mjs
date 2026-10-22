// Local QA of 20261020140000_filter_links_seen_last.sql: with seen_last, filter_links
// lists the links the caller saw at or before as_of last (each part newest
// first), keyset pages by (seen, created_at, id) equal one page, and without
// it, or with no session, the order is what it was. Same schema and seeds as
// keyset_db.mjs, plus visits and impressions.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { readFileSync } from "node:fs";

const [senses, keyset, seenLast] = process.argv.slice(2);
const db = new PGlite({ extensions: { ltree } });

await db.exec(`
create extension ltree;
create schema extensions;
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
create table public.profiles (id uuid primary key);
create table public.kinds (
  path ltree primary key check (subpath(path, 0, 1) = 'entity'),
  label text not null, description text,
  parent ltree generated always as (case when nlevel(path) > 1 then subpath(path, 0, nlevel(path) - 1) end) stored references public.kinds(path)
);
insert into kinds (path, label) values ('entity','Entity'),('entity.place','Place'),('entity.event','Event'),
  ('entity.artifact','Artifact'),('entity.artifact.work','Work'),('entity.period','Period');
create table public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  kind_path ltree references kinds(path),
  constraint entities_name_key unique (name),
  constraint entities_kind_check check (kind in ('company','cooperative','nonprofit','public_body','person','product','place','event','work','other'))
);
create function kind_to_path(k text) returns ltree language sql immutable as $$
  select case k when 'place' then 'entity.place' when 'event' then 'entity.event' when 'work' then 'entity.artifact.work' else 'entity' end::ltree $$;
create function sync_kind() returns trigger language plpgsql as $$ begin new.kind_path := coalesce(new.kind_path, kind_to_path(new.kind)); return new; end $$;
create trigger sync before insert on entities for each row execute function sync_kind();
create table public.links (id uuid primary key default gen_random_uuid(), title text, created_at timestamptz not null default now());
create table public.link_entities (link_id uuid references links(id), entity_id uuid references entities(id), primary key (link_id, entity_id));
create table public.link_topics (link_id uuid references links(id), topic_id ltree);
create table public.link_visits (link_id uuid references links(id), visitor_id uuid references profiles(id),
  visited_at timestamptz not null default now());
alter table public.link_visits enable row level security;
create policy own on public.link_visits for select to authenticated using (auth.uid() = visitor_id);
create table public.link_impressions (viewer_id uuid references profiles(id), link_id uuid references links(id),
  seen_at timestamptz not null default now());
alter table public.link_impressions enable row level security;
create policy own on public.link_impressions for select to authenticated using (auth.uid() = viewer_id);
create table public.link_events (id uuid primary key default gen_random_uuid(), link_id uuid references links(id),
  starts_on date, ends_on date, start_time time);
`);

// Seeds. "Now" for the checks is Fri 2026-10-16 21:30 local.
const link = async (title, ev, ents = [], topic = null, ageMin = 0) => {
  const { rows: [{ id }] } = await db.query(
    `insert into links (title, created_at) values ($1, now() - make_interval(mins => $2)) returning id`, [title, ageMin]);
  for (const e of ev) await db.query(`insert into link_events (link_id, starts_on, ends_on, start_time) values ($1,$2,$3,$4)`, [id, ...e]);
  for (const e of ents) await db.query(`insert into link_entities values ($1, (select id from entities where name=$2 and kind=$3))`, [id, ...e]);
  if (topic) await db.query(`insert into link_topics values ($1, $2)`, [id, topic]);
  return id;
};
await db.exec(`insert into entities (name, kind) values ('Paris','place'),('Jazz Festival','event'),('Lyon','place')`);
await link("concert tonight 21:00 Paris", [["2026-10-16", null, "21:00"]], [["Paris", "place"], ["Jazz Festival", "event"]], "culture.music", 1);
await link("talk this morning 10:00, no end", [["2026-10-16", null, "10:00"]], [["Paris", "place"]], null, 2);
await link("exhibition all month", [["2026-10-01", "2026-10-31", null]], [["Lyon", "place"]], "culture.art", 3);
await link("club night 02:00 tomorrow", [["2026-10-17", null, "02:00"]], [], null, 4);
await link("market tomorrow, all day", [["2026-10-17", null, null]], [["Paris", "place"]], null, 5);
await link("open-ended run until Nov", [[null, "2026-11-15", null]], [], null, 6);
await link("next week", [["2026-10-23", null, "19:00"]], [["Paris", "place"]], null, 7);
await link("no events, Paris article", [], [["Paris", "place"]], "culture.music.jazz", 8);

await db.exec(readFileSync(senses, "utf8"));
await db.exec(readFileSync(keyset, "utf8"));
const F = '[{"kind":"entity"}]';
const before = (await db.query(`select link_id from filter_links($1::jsonb, 100)`, [F])).rows.map((r) => r.link_id);
await db.exec(readFileSync(seenLast, "utf8"));
await db.exec(`
grant usage on schema public, extensions to authenticated, anon;
grant select on all tables in schema public to authenticated;
grant select on public.links, public.entities, public.kinds, public.link_entities, public.link_topics, public.link_events to anon;
grant execute on all functions in schema public to authenticated, anon;
`);

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
await db.query(`insert into profiles values ($1), ($2)`, [A, B]);
const titles = new Map((await db.query(`select id, title from links`)).rows.map((r) => [r.id, r.title]));
const idOf = (prefix) => [...titles].find(([, t]) => t.startsWith(prefix))[0];
const asOf = (await db.query(`select now() + interval '1 hour' as t`)).rows[0].t;
// A clicked the concert and had the exhibition and the market on screen
// before as_of, and the talk only after it; B had the next-week link on screen.
await db.query(`insert into link_visits values ($1, $2, now())`, [idOf("concert"), A]);
await db.query(`insert into link_impressions values ($1, $2, now()), ($1, $3, now()), ($1, $4, now() + interval '2 hours'), ($5, $6, now())`,
  [A, idOf("exhibition"), idOf("market"), idOf("talk"), B, idOf("next week")]);

const as = async (role, uid, sql, params) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role;");
  }
};
const SEEN_SQL = `select link_id, created_at, seen from filter_links($1::jsonb, $2, 0, $3, $4, true, $5, $6)`;
const pages = async (role, uid, size) => {
  let cursor = null; const got = [];
  for (let i = 0; i < 50; i++) {
    const rows = await as(role, uid, SEEN_SQL, [F, size, cursor?.created_at ?? null, cursor?.link_id ?? null, asOf, cursor?.seen ?? null]);
    got.push(...rows);
    if (rows.length < size) break;
    cursor = rows.at(-1);
  }
  return got;
};
const names = (rows) => rows.map((r) => titles.get(r.link_id).split(" ")[0]);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const one = await pages("authenticated", A, 100);
const want = ["talk", "next", "no", "concert", "exhibition", "market"];
check("A: unseen newest first, then what A saw at or before as_of", JSON.stringify(names(one)) === JSON.stringify(want), names(one).join(", "));
for (const size of [1, 2, 3]) {
  const got = await pages("authenticated", A, size);
  check(`A: keyset pages of ${size} = one page`, JSON.stringify(names(got)) === JSON.stringify(want), names(got).join(", "));
}
const b = names(await pages("authenticated", B, 100));
check("B: only B's own impressions count", b.at(-1) === "next" && b.length === 6, b.join(", "));
const anon = await pages("anon", null, 2);
check("anon: plain newest first, nothing seen", anon.every((r) => !r.seen) && JSON.stringify(anon.map((r) => r.link_id)) === JSON.stringify(before), names(anon).join(", "));
const plain = (await as("authenticated", A, `select link_id, seen from filter_links($1::jsonb, 100)`, [F]));
check("without seen_last the order is newest first, as before", JSON.stringify(plain.map((r) => r.link_id)) === JSON.stringify(before) && plain.every((r) => !r.seen));
const oldKeyset = (await as("authenticated", A, `select link_id from filter_links($1::jsonb, 2, 0, $2, $3)`, [F, plain[1] && (await db.query(`select created_at from links where id = $1`, [plain[1].link_id])).rows[0].created_at, plain[1].link_id]));
check("the old keyset call still pages newest first", JSON.stringify(oldKeyset.map((r) => r.link_id)) === JSON.stringify(before.slice(2, 4)));
try {
  await db.query(`select * from filter_links($1::jsonb, 1, 0, null, null, true)`, [F]);
  check("seen_last needs as_of", false);
} catch (e) {
  check("seen_last needs as_of", /needs as_of/.test(e.message));
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
