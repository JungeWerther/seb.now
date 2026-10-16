// Local QA of the keyset filter_links migration, on the same production-shaped
// schema and seeds as senses_db.mjs: senses_and_indexicals first (what's live),
// then the keyset migration on top.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { readFileSync } from "node:fs";

const [senses, keyset] = process.argv.slice(2);
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

await db.exec(readFileSync(senses, "utf8"));
// What the page reads before the keyset migration (offset pages).
const before = (await db.query(`select link_id from filter_links('[{"kind":"entity"}]', 100)`)).rows.map((r) => r.link_id);
await db.exec(readFileSync(keyset, "utf8"));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const filters = [
  ['[{"kind":"entity"}]', "every link with an entity"],
  ['[{"kind":"entity.place"},{"any":[{"kind":"entity.event"},{"topic":"culture"}]}]', "a place and (an event or culture)"],
  ['[{"period":["2026-10-16T18:00","2026-10-17T04:00"]}]', "tonight as a period"],
];
for (const [f, name] of filters) {
  const all = (await db.query(`select link_id, created_at from filter_links($1::jsonb, 100)`, [f])).rows;
  for (const size of [1, 2, 3]) {
    let cursor = null; const seen = [];
    for (let i = 0; i < 50; i++) {
      const { rows } = await db.query(`select link_id, created_at from filter_links($1::jsonb, $2, 0, $3, $4)`,
        [f, size, cursor?.created_at ?? null, cursor?.link_id ?? null]);
      seen.push(...rows.map((r) => r.link_id));
      if (rows.length < size) break;
      cursor = rows.at(-1);
    }
    const viaOffset = [];
    for (let off = 0; ; off += size) {
      const { rows } = await db.query(`select link_id from filter_links($1::jsonb, $2, $3)`, [f, size, off]);
      viaOffset.push(...rows.map((r) => r.link_id));
      if (rows.length < size) break;
    }
    check(`${name}: keyset pages of ${size} = offset pages = one page`,
      JSON.stringify(seen) === JSON.stringify(viaOffset) && JSON.stringify(seen) === JSON.stringify(all.map((r) => r.link_id)),
      `${seen.length} links`);
  }
}
const after = (await db.query(`select link_id from filter_links('[{"kind":"entity"}]', 100)`)).rows.map((r) => r.link_id);
check("the old call (filters, max_results) lists the same links as before the migration", JSON.stringify(before) === JSON.stringify(after), `${after.length} links`);
const cols = (await db.query(`select * from filter_links('[{"kind":"entity"}]', 1)`)).fields.map((f) => f.name);
check("rows carry created_at for the next cursor", JSON.stringify(cols) === JSON.stringify(["link_id", "entity_ids", "created_at"]), cols.join(", "));
try {
  await db.query(`select * from filter_links('[{"kind":"entity"}]', 1, 0, now(), null)`);
  check("a cursor needs both halves", false);
} catch (e) {
  check("a cursor needs both halves", /go together/.test(e.message));
}
const grants = (await db.query(`select has_function_privilege('anon', 'filter_links(jsonb,integer,integer,timestamptz,uuid)', 'execute') as anon`)).rows[0];
check("anon can call it", grants.anon === true);
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
