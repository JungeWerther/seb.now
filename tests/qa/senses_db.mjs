// Local QA of the senses/indexicals migration against a schema shaped like
// production (only the tables it touches), with seeded links and events.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { readFileSync } from "node:fs";

const [migration] = process.argv.slice(2);
const db = new PGlite({ extensions: { ltree } });

await db.exec(`
create extension ltree;
create schema extensions;
create role anon; create role authenticated;
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

await db.exec(readFileSync(migration, "utf8"));

const one = async (sql, params = []) => (await db.query(sql, params)).rows;
const titles = async (filters) =>
  (await one(`select l.title from filter_links($1::jsonb, 100) f join links l on l.id = f.link_id order by l.created_at desc`, [JSON.stringify(filters)])).map((r) => r.title);
const at = "2026-10-16T21:30";
const paris = (await one(`select id from entities where name='Paris'`))[0].id;

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
};
const iv = async (term, t) => (await one(`select indexical_interval($1, $2)::text as r`, [term, t]))[0].r;

check("tonight at 21:30", await iv("tonight", at), '["2026-10-16 18:00:00","2026-10-17 04:00:00")');
check("tonight at 01:30 is still last night", await iv("tonight", "2026-10-17T01:30"), '["2026-10-16 18:00:00","2026-10-17 04:00:00")');
check("tonight at 05:00 is the coming night", await iv("tonight", "2026-10-17T05:00"), '["2026-10-17 18:00:00","2026-10-18 04:00:00")');
check("tomorrow", await iv("tomorrow", at), '["2026-10-17 00:00:00","2026-10-18 00:00:00")');
check("this has no interval", await iv("this", at), null);
check("10:00 talk with no end lasts 3h",
  (await one(`select link_event_range('2026-10-16', null, '10:00')::text as r`))[0].r, '["2026-10-16 10:00:00","2026-10-16 13:00:00")');

check("tonight", await titles([{ indexical: "tonight", at }]),
  ["concert tonight 21:00 Paris", "exhibition all month", "club night 02:00 tomorrow", "open-ended run until Nov"]);
check("tomorrow", await titles([{ indexical: "tomorrow", at }]),
  ["exhibition all month", "club night 02:00 tomorrow", "market tomorrow, all day", "open-ended run until Nov"]);
check("event tonight (kind ∧ indexical)", await titles([{ kind: "entity.event" }, { indexical: "tonight", at }]),
  ["concert tonight 21:00 Paris"]);
check("old [from,to] form still works", await titles([{ period: ["2026-10-16T18:00", "2026-10-17T04:00"] }]),
  await titles([{ indexical: "tonight", at }]));
check("this on Paris = Paris", await titles([{ indexical: "this", focus: { entity: paris } }]),
  await titles([{ entities: [paris] }]));
check("tonight this (Paris page)", await titles([{ indexical: "tonight", at }, { indexical: "this", focus: { entity: paris } }]),
  ["concert tonight 21:00 Paris"]);
check("this on the Place kind page", await titles([{ indexical: "this", focus: { kind: "entity.place" } }]),
  await titles([{ kind: "entity.place" }]));
check("this on topic culture.music includes subtopics", await titles([{ indexical: "this", focus: { topic: "culture.music" } }]),
  ["concert tonight 21:00 Paris", "no events, Paris article"]);
check("superposition: any(tonight, Lyon)", await titles([{ any: [{ indexical: "tonight", at }, { kind: "entity.place" }] }]),
  ["concert tonight 21:00 Paris", "talk this morning 10:00, no end", "exhibition all month", "club night 02:00 tomorrow",
   "market tomorrow, all day", "open-ended run until Nov", "next week", "no events, Paris article"]);
check("superposition ∧ constraint prunes", await titles([{ any: [{ indexical: "tonight", at }, { entities: [paris] }] }, { kind: "entity.event" }]),
  ["concert tonight 21:00 Paris"]);
const logged = (await one(`select entity_ids from filter_links($1::jsonb) where cardinality(entity_ids) > 0`,
  [JSON.stringify([{ kind: "entity.event" }, { indexical: "tonight", at }])]));
check("log keeps matched entities, periods log none", logged.length === 1 && logged[0].entity_ids.length === 1, true);

const summary = (await one(`select * from indexical_summary('tonight', $1)`, [at]))[0];
check("tonight summary", [String(summary.starts), summary.posts, summary.kind_path], [String(new Date("2026-10-16T18:00:00")), 4, "entity.period"]);
const thisSummary = (await one(`select * from indexical_summary('this', $1)`, [at]))[0];
check("this summary", [thisSummary.context, thisSummary.starts, thisSummary.posts, thisSummary.kind_path], ["focus", null, null, "entity"]);

const err = async (filters) => { try { await titles(filters); return "allowed"; } catch (e) { return e.message; } };
check("unknown indexical rejected", await err([{ indexical: "yesterday", at }]), "unknown indexical yesterday");
check("tonight without at rejected", await err([{ indexical: "tonight" }]), "the time indexical tonight needs at");
check("this without focus rejected", await err([{ indexical: "this" }]), "the focus indexical this needs focus");
check("two keys in a sense rejected", await err([{ kind: "entity.place", indexical: "tonight" }]), "a sense has exactly one of kind, entities, topic, period, indexical");
check("empty any rejected", await err([{ any: [] }]), "any must be an array of 1 to 8 senses");

const ins = async (name, kind) => { try { await db.query(`insert into entities (name, kind) values ($1,$2)`, [name, kind]); return "ok"; } catch (e) { return e.message.includes("entities_name_kind_key") ? "rejected" : e.message; } };
check("same name, another kind: a new sense", [await ins("Tonight", "work"), await ins("Tonight", "place")], ["ok", "ok"]);
check("same name, same kind, other case: rejected", await ins("TONIGHT", "work"), "rejected");
check("period kind is ready for indexicals", (await one(`select count(*)::int as n from indexicals where kind_path = 'entity.period'`))[0].n, 2);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
