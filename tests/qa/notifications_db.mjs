// Local QA of the notifications migration, on a schema shaped like production
// (profiles, links, remote actors and replies with their RLS): the trigger as
// local and fediverse replies fire it, then what each reader can see and mark.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const [migration] = process.argv.slice(2);
const db = new PGlite();

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create table public.profiles (id uuid primary key, handle text unique);
alter table public.profiles enable row level security;
create policy "profiles are public" on public.profiles for select to anon, authenticated using (true);
grant select on public.profiles to anon, authenticated;
create table public.links (id uuid primary key default gen_random_uuid(), title text not null);
create table public.remote_actors (id uuid primary key default gen_random_uuid(), handle text not null);
create table public.replies (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete cascade,
  remote_actor_id uuid references public.remote_actors(id) on delete cascade,
  body text not null,
  ap_object_id text unique,
  created_at timestamptz not null default now(),
  constraint replies_one_author check (num_nonnulls(author_id, remote_actor_id) = 1)
);
alter table public.replies enable row level security;
create policy "replies are public" on public.replies for select to anon, authenticated using (true);
create policy "own replies" on public.replies for insert to authenticated with check (auth.uid() = author_id);
grant select, insert on public.replies to anon, authenticated;
`);
await db.exec(readFileSync(migration, "utf8"));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
}

const alice = "00000000-0000-0000-0000-00000000000a";
const bob = "00000000-0000-0000-0000-00000000000b";
const carol = "00000000-0000-0000-0000-00000000000c";
await db.exec(`insert into profiles values ('${alice}', 'alice'), ('${bob}', 'bob'), ('${carol}', 'carol')`);
const link = (await db.query(`insert into links (title) values ('A story') returning id`)).rows[0].id;
const other = (await db.query(`insert into links (title) values ('Another') returning id`)).rows[0].id;
const remote = (await db.query(`insert into remote_actors (handle) values ('@dana@example.social') returning id`)).rows[0].id;

async function as(user, sql, params) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}
const inbox = async (user) =>
  (await db.query(`select kind, reply_id from notifications where recipient_id = $1 order by created_at, kind`, [user])).rows;

// Alice replies first: nobody to tell.
const a1 = (await as(alice, `insert into replies (link_id, author_id, body) values ($1, $2, 'first') returning id`, [link, alice])).rows[0].id;
check("a first reply notifies nobody", (await db.query(`select count(*)::int n from notifications`)).rows[0].n === 0);

// Bob replies on the same link through RLS: Alice hears of it, Bob doesn't.
const b1 = (await as(bob, `insert into replies (link_id, author_id, body) values ($1, $2, 'second') returning id`, [link, bob])).rows[0].id;
let rows = await inbox(alice);
check("a reply on a thread notifies earlier repliers", rows.length === 1 && rows[0].kind === "reply_on_thread" && rows[0].reply_id === b1, JSON.stringify(rows));
check("nobody is notified of their own reply", (await inbox(bob)).length === 0);

// Alice replies again: Bob once, Alice never.
await as(alice, `insert into replies (link_id, author_id, body) values ($1, $2, 'third')`, [link, alice]);
check("each earlier replier is told once", (await inbox(bob)).length === 1 && (await inbox(alice)).length === 1);

// A fediverse reply to Bob's comment: Bob gets reply_to_you (only), Alice reply_on_thread.
const r1 = (await db.query(
  `insert into replies (link_id, remote_actor_id, body, ap_object_id, in_reply_to_id) values ($1, $2, 'hi bob', 'https://example.social/1', $3) returning id`,
  [link, remote, b1],
)).rows[0].id;
rows = (await inbox(bob)).filter((r) => r.reply_id === r1);
check("a remote reply to your reply is reply_to_you, once", rows.length === 1 && rows[0].kind === "reply_to_you", JSON.stringify(rows));
rows = (await inbox(alice)).filter((r) => r.reply_id === r1);
check("a remote reply on a thread notifies its local repliers", rows.length === 1 && rows[0].kind === "reply_on_thread", JSON.stringify(rows));

// A redelivered note (upsert on ap_object_id) doesn't notify again.
await db.query(
  `insert into replies (link_id, remote_actor_id, body, ap_object_id) values ($1, $2, 'hi bob (edited)', 'https://example.social/1')
   on conflict (ap_object_id) do update set body = excluded.body`,
  [link, remote],
);
check("a redelivered remote reply isn't notified twice", (await db.query(`select count(*)::int n from notifications where reply_id = $1`, [r1])).rows[0].n === 2);

// A reply on another link notifies nobody from this one.
await as(carol, `insert into replies (link_id, author_id, body) values ($1, $2, 'elsewhere')`, [other, carol]);
check("replies elsewhere don't reach this thread", (await inbox(alice)).length === 2 && (await inbox(bob)).length === 2);

// RLS: each reader sees only their own; no client inserts; only read_at updates.
rows = (await as(alice, `select recipient_id from notifications`)).rows;
check("a reader sees only their own notifications", rows.length === 2 && rows.every((r) => r.recipient_id === alice), JSON.stringify(rows));
check("carol sees none", (await as(carol, `select * from notifications`)).rows.length === 0);
let refused = false;
try {
  await as(carol, `insert into notifications (recipient_id, kind, reply_id) values ($1, 'reply_on_thread', $2)`, [carol, a1]);
} catch {
  refused = true;
}
check("clients can't insert notifications", refused);
refused = false;
try {
  await as(alice, `update notifications set kind = 'reply_to_you'`);
} catch {
  refused = true;
}
check("clients can only update read_at", refused);
await as(carol, `update notifications set read_at = now()`);
check("a reader can't mark someone else's read", (await db.query(`select count(*)::int n from notifications where read_at is not null`)).rows[0].n === 0);

// Marking read: only the given ids, only the caller's.
const aliceIds = (await db.query(`select id from notifications where recipient_id = $1 order by created_at`, [alice])).rows.map((r) => r.id);
const bobIds = (await db.query(`select id from notifications where recipient_id = $1`, [bob])).rows.map((r) => r.id);
let marked = (await as(alice, `select mark_notifications_read($1::uuid[]) n`, [[aliceIds[0], ...bobIds]])).rows[0].n;
check("mark_notifications_read marks only the caller's given ones", marked === 1, String(marked));
marked = (await as(alice, `select mark_notifications_read($1::uuid[]) n`, [aliceIds])).rows[0].n;
check("already-read ones aren't counted again", marked === 1, String(marked));
check("bob's stay unread", (await db.query(`select count(*)::int n from notifications where recipient_id = $1 and read_at is null`, [bob])).rows[0].n === 2);
refused = false;
try {
  await db.exec(`set role anon; select mark_notifications_read('{}'::uuid[]);`);
} catch {
  refused = true;
} finally {
  await db.exec(`reset role`);
}
check("anon can't call mark_notifications_read", refused);

// Deleting a reply removes its notifications; deleting the replied-to one keeps the answer.
await db.query(`delete from replies where id = $1`, [b1]);
check("deleting a reply drops its notifications", (await db.query(`select count(*)::int n from notifications where reply_id = $1`, [b1])).rows[0].n === 0);
check("the answer to a deleted reply stays, unlinked", (await db.query(`select in_reply_to_id from replies where id = $1`, [r1])).rows[0].in_reply_to_id === null);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
