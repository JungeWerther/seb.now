// Local QA of the entity_sense migration on an embedded Postgres shaped like
// ours: drop a mention and undo it, merge two entities and undo it, and check
// that every touched table comes back exactly as it was; then place a venue in
// a city and check containment, the place-kind rule and the cycle guard.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [migration] = process.argv.slice(2);
const db = new PGlite({ extensions: { ltree, pg_trgm } });

await db.exec(`
create schema extensions;
create extension ltree schema extensions;
create extension pg_trgm schema extensions;
set search_path = public, extensions;
create role anon; create role authenticated;
create table public.kinds (path extensions.ltree primary key, label text not null);
insert into kinds values ('entity','Entity'),('entity.place','Place'),('entity.agent','Agent'),('entity.agent.org','Org'),('entity.agent.org.public_body','Public body');
create table public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null, kind text not null,
  nace_code text, country text, wikidata_id text unique, website text, description text,
  created_at timestamptz not null default now(),
  kind_path extensions.ltree references kinds(path),
  seq bigint generated always as identity
);
create function public.kind_to_path(k text) returns extensions.ltree language sql immutable as $$
  select case k when 'place' then 'entity.place' when 'public_body' then 'entity.agent.org.public_body' else 'entity' end::extensions.ltree $$;
create function public.sync_kind() returns trigger language plpgsql as $$ begin new.kind_path := coalesce(new.kind_path, public.kind_to_path(new.kind)); return new; end $$;
create trigger sync before insert on entities for each row execute function public.sync_kind();
create table public.links (id uuid primary key default gen_random_uuid(), title text);
create table public.link_entities (
  link_id uuid not null references links(id), entity_id uuid not null references entities(id) on delete cascade,
  surface text, p real not null default 1, labeled_by text not null default 'manual',
  created_at timestamptz not null default now(), found_in text not null default 'title',
  seq bigint generated always as identity, primary key (link_id, entity_id)
);
create function public.witness_label(s text) returns text language sql immutable as $$ select nullif(lower(btrim(s)), '') $$;
create table public.identity_witnesses (
  id bigint generated always as identity primary key, sense text not null, entity_id uuid not null references entities(id) on delete cascade,
  value text not null, link_id uuid references links(id), surface text, p real not null, labeled_by text not null,
  created_at timestamptz not null default now(), unique nulls not distinct (sense, entity_id, value, link_id)
);
create function add_witness() returns trigger language plpgsql as $$ begin
  insert into public.identity_witnesses (sense, entity_id, value, link_id, surface, p, labeled_by)
  values ('label', new.entity_id, public.witness_label(new.surface), new.link_id, new.surface, new.p, new.labeled_by) on conflict do nothing;
  return new; end $$;
create trigger add_witness after insert on link_entities for each row execute function add_witness();
create table public.entity_relations (
  id uuid primary key default gen_random_uuid(), subject_id uuid not null references entities(id) on delete cascade,
  relation text not null, object_id uuid not null references entities(id) on delete cascade, link_id uuid not null references links(id),
  status text not null default 'stated', p real not null default 1, labeled_by text not null default 'manual', created_at timestamptz not null default now()
);
create table public.entity_properties (
  id uuid primary key default gen_random_uuid(), entity_id uuid not null references entities(id) on delete cascade,
  link_id uuid not null references links(id), facet text not null, value text not null
);
create table public.link_events (id uuid primary key default gen_random_uuid(), link_id uuid references links(id), venue_entity_id uuid references entities(id) on delete set null);
create table public.sources (id uuid primary key default gen_random_uuid(), entity_id uuid references entities(id) on delete set null);
create table public.index_state (id boolean primary key default true check (id), gen bigint not null default 1);
insert into public.index_state default values;
`);

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const id = async (name) => (await one(`select id from entities where name = $1`, [name])).id;

await db.exec(`insert into entities (name, kind, country) values
  ('Pentagon','public_body', null), ('The Pentagon','public_body','US'), ('Department of War','public_body', null),
  ('Paris','place', 'FR'), ('Tokyo','place', 'JP'), ('Palais de Tokyo','place', null), ('Musée Rodin','other', null)`);
const l1 = (await one(`insert into links (title) values ('Pentagon budget') returning id`)).id;
const l2 = (await one(`insert into links (title) values ('The Pentagon and the Palais de Tokyo') returning id`)).id;
const mention = (link, name, surface) =>
  db.query(`insert into link_entities (link_id, entity_id, surface, labeled_by, found_in) values ($1, (select id from entities where name=$2), $3, 'jev', 'page')`, [link, name, surface]);
await mention(l1, "Pentagon", "Pentagon");
await mention(l2, "Pentagon", "Pentagon");
await mention(l2, "The Pentagon", "The Pentagon");
await mention(l1, "The Pentagon", "the Pentagon");
await mention(l2, "Palais de Tokyo", "Palais de Tokyo");
await mention(l2, "Tokyo", "Tokyo");
await db.query(`insert into entity_relations (subject_id, relation, object_id, link_id) values ($1,'part_of',$2,$3), ($2,'regulates',$4,$3)`,
  [await id("The Pentagon"), await id("Pentagon"), l2, await id("Paris")]);
await db.query(`insert into entity_properties (entity_id, link_id, facet, value) values ($1, $2, 'origin', 'American')`, [await id("The Pentagon"), l1]);
await db.query(`insert into link_events (link_id, venue_entity_id) values ($1, $2)`, [l2, await id("The Pentagon")]);
await db.query(`insert into sources (entity_id) values ($1)`, [await id("The Pentagon")]);
await db.query(`update entities set wikidata_id = 'Q11208' where name = 'The Pentagon'`);
// A former name whose only mention collides with the target's on the same link.
await mention(l2, "Department of War", "Department of War");

await db.exec(readFileSync(migration, "utf8"));

const TABLES = ["entities", "link_entities", "identity_witnesses", "entity_relations", "entity_properties", "link_events", "sources"];
const dump = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) =>
  [t, (await db.query(`select to_jsonb(x) j from ${t} x order by 1`)).rows.map((r) => JSON.stringify(r.j)).sort()])));

// 1. Dropping "Tokyo" read out of "Palais de Tokyo", then undoing it.
const before = await dump();
const drop = (await one(`insert into entity_edits (batch, op, link_id, entity_id, entity_name, decided_by, reason)
  values ('qa-drop', 'drop_mention', $1, $2, 'Tokyo', 'claude', 'only part of "Palais de Tokyo"') returning id`, [l2, await id("Tokyo")])).id;
await db.query(`select apply_entity_edit($1)`, [drop]);
assert.equal((await one(`select count(*)::int n from link_entities where entity_id = $1`, [await id("Tokyo")])).n, 0, "mention dropped");
assert.equal((await one(`select count(*)::int n from identity_witnesses where entity_id = $1 and sense = 'label'`, [await id("Tokyo")])).n, 0, "its witness dropped");
await assert.rejects(db.query(`select apply_entity_edit($1)`, [drop]), /not staged/, "an edit applies once");
const gen = async () => (await one(`select gen from index_state`)).gen;
const genBefore = await gen();
await db.query(`select undo_entity_edit($1)`, [drop]);
assert.deepEqual(await dump(), before, "undoing a drop restores every row");
assert.equal(Number(await gen()), Number(genBefore) + 1, "undo starts a new index generation");

// 2. Merging "The Pentagon" into "Pentagon", then undoing it.
const merge = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
  values ('qa-merge', 'merge', $1, 'The Pentagon', $2, 'Pentagon', 'claude') returning id`, [await id("The Pentagon"), await id("Pentagon")])).id;
const staleBefore = async () => (await one(`select status, entity_id from entity_edits where batch = 'qa-merge' and op = 'drop_mention'`));
const stale = (await one(`insert into entity_edits (batch, op, link_id, entity_id, entity_name, decided_by)
  values ('qa-merge', 'drop_mention', $1, $2, 'The Pentagon', 'claude') returning id`, [l1, await id("The Pentagon")])).id;
await db.query(`select apply_entity_edit($1)`, [merge]);
const pentagon = await id("Pentagon");
assert.equal((await one(`select count(*)::int n from entities where name = 'The Pentagon'`)).n, 0, "merged-away entity gone");
assert.equal((await one(`select count(*)::int n from link_entities where entity_id = $1`, [pentagon])).n, 2, "one mention per link");
assert.equal((await one(`select country from entities where id = $1`, [pentagon])).country, "US", "empty fields filled");
assert.equal((await one(`select count(*)::int n from entity_relations where subject_id = object_id`)).n, 0, "no self-loops");
assert.equal((await one(`select count(*)::int n from entity_relations where subject_id = $1`, [pentagon])).n, 1, "other claims move over");
assert.equal((await one(`select venue_entity_id v from link_events`)).v, pentagon, "venues move over");
assert.equal((await one(`select entity_id v from sources`)).v, pentagon, "sources move over");
assert.ok((await one(`select 1 x from identity_witnesses where entity_id = $1 and value = 'the pentagon' and labeled_by = 'merge'`, [pentagon])), "old name kept as a label");
assert.equal((await one(`select status from entity_edits where id = $1`, [stale])).status, "rejected", "staged edits about it are superseded");
assert.equal((await one(`select wikidata_id from entities where id = $1`, [pentagon])).wikidata_id, "Q11208", "the wikidata id moves over");
await db.query(`select undo_entity_edit($1)`, [merge]);
assert.deepEqual(await dump(), before, "undoing a merge restores every row, a moved wikidata id included");
assert.equal((await staleBefore()).status, "staged", "superseded edits are staged again after undo");

// 2b. A former name stays a candidate even when every mention collided.
const war = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
  values ('qa-alias', 'merge', $1, 'Department of War', $2, null, 'claude') returning id`, [await id("Department of War"), pentagon])).id;
await db.query(`select apply_entity_edit($1)`, [war]);
assert.ok((await db.query(`select 1 from entity_candidates('Department of War') where id = $1`, [pentagon])).rows.length,
  "a merged-away name still finds its entity");
// Undo goes in reverse order: a later edit about the same entity blocks an earlier one.
const later = (await one(`insert into entity_edits (batch, op, link_id, entity_id, entity_name, decided_by)
  values ('qa-alias', 'drop_mention', $1, $2, 'Pentagon', 'claude') returning id`, [l1, pentagon])).id;
await db.query(`select apply_entity_edit($1)`, [later]);
await assert.rejects(db.query(`select undo_entity_edit($1)`, [war]), /later applied edits/, "undo in reverse order");
await db.query(`select undo_entity_edit($1)`, [later]);
await db.query(`select undo_entity_edit($1)`, [war]);
assert.deepEqual(await dump(), before, "both undone, everything is back");

// 3. Where places are.
const place = (child, parent) => db.query(`select set_place_parent($1, $2, 'manual')`, [child, parent]);
await place(await id("Palais de Tokyo"), await id("Paris"));
assert.equal((await one(`select place_within($1, $2) b`, [await id("Palais de Tokyo"), await id("Paris")])).b, true, "Palais de Tokyo is in Paris");
assert.equal((await one(`select place_within($1, $2) b`, [await id("Palais de Tokyo"), await id("Tokyo")])).b, false, "and not in Tokyo");
assert.deepEqual((await db.query(`select name, depth from place_ancestors($1)`, [await id("Palais de Tokyo")])).rows, [{ name: "Paris", depth: 1 }]);
await assert.rejects(place(await id("Paris"), await id("Palais de Tokyo")), /cycle/, "no cycles");
await assert.rejects(place(await id("Tokyo"), await id("Musée Rodin")), /not a place/, "a parent is a place");
assert.deepEqual((await db.query(`select name from places_to_resolve(10)`)).rows.map((r) => r.name).sort(), ["Palais de Tokyo", "Paris", "Tokyo"]);

// Placing a place moves everything inside it: built bottom up, a deep chain
// still answers containment and can't be closed into a cycle.
await db.exec(`insert into entities (name, kind) select 'P' || i, 'place' from generate_series(0, 40) i`);
for (let i = 0; i < 40; i++) await place(await id(`P${i}`), await id(`P${i + 1}`));
assert.equal((await one(`select place_within($1, $2) b`, [await id("P0"), await id("P40")])).b, true, "deep containment after moving subtrees");
assert.equal((await one(`select count(*)::int n from place_ancestors($1)`, [await id("P0")])).n, 40);
await assert.rejects(place(await id("P40"), await id("P0")), /cycle/, "no cycles, however deep");

// 4. Merging a placed duplicate into an unplaced one keeps it placed, moves
// what was inside it, and undoes exactly; a later merge touching a moved place
// must be undone first; edits applied in one transaction keep their order.
await db.exec(`insert into entities (name, kind) values ('Le Palais','place'), ('Palais','place'), ('Salle 1','place'), ('Salle Une','place')`);
await place(await id("Le Palais"), await id("Paris"));
await place(await id("Salle 1"), await id("Le Palais"));
const placesBefore = await dump();
const [m1, m2] = [
  (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
    values ('qa-place', 'merge', $1, 'Le Palais', $2, 'Palais', 'claude') returning id`, [await id("Le Palais"), await id("Palais")])).id,
  (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
    values ('qa-place', 'merge', $1, 'Salle 1', $2, 'Salle Une', 'claude') returning id`, [await id("Salle 1"), await id("Salle Une")])).id,
];
await db.exec(`begin; select apply_entity_edit(${m2 > m1 ? m1 : m2}); commit;`);
assert.equal((await one(`select place_within($1, $2) b`, [await id("Palais"), await id("Paris")])).b, true, "the kept entity takes the parent");
assert.equal((await one(`select place_within($1, $2) b`, [await id("Salle 1"), await id("Palais")])).b, true, "what was inside moves inside the kept one");
await db.query(`select apply_entity_edit($1)`, [m2]);
await assert.rejects(db.query(`select undo_entity_edit($1)`, [m1]), /later applied edits/, "a later merge of a moved place blocks undo");
await db.query(`select undo_entity_edit($1)`, [m2]);
await db.query(`select undo_entity_edit($1)`, [m1]);
assert.deepEqual(await dump(), placesBefore, "placed merges undo exactly");
// A place put inside the kept entity after a merge blocks its undo.
await db.query(`select apply_entity_edit(id) from entity_edits where id = $1`, [
  (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
    values ('qa-later', 'merge', $1, 'Le Palais', $2, 'Palais', 'claude') returning id`, [await id("Le Palais"), await id("Palais")])).id]);
const lateMerge = (await one(`select id from entity_edits where batch = 'qa-later'`)).id;
await db.exec(`insert into entities (name, kind) values ('Salle 2','place')`);
await place(await id("Salle 2"), await id("Palais"));
await assert.rejects(db.query(`select undo_entity_edit($1)`, [lateMerge]), /changed since/, "later placements block undo");
await place(await id("Salle 2"), await id("Tokyo"));
await db.query(`select undo_entity_edit($1)`, [lateMerge]);
await db.query(`delete from entities where name = 'Salle 2'`);
assert.deepEqual(await dump(), placesBefore, "once moved back out, the merge undoes exactly");

// A merge can't move places inside a non-place.
await db.exec(`insert into entities (name, kind) values ('Musée Org','other')`);
await assert.rejects(db.query(`select apply_entity_edit($1)`, [
  (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
    values ('qa-kind', 'merge', $1, 'Le Palais', $2, 'Musée Org', 'claude') returning id`, [await id("Le Palais"), await id("Musée Org")])).id]),
  /not a place/, "places never end up inside a non-place");

// Merges that rewrote the same staged judgment must be undone in reverse order.
await db.exec(`insert into entities (name, kind) values ('Aa','place'), ('Bb','place'), ('Cc','place'), ('Dd','place')`);
await db.query(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-keep', 'keep', $1, 'Aa', $2, 'Cc', 'claude')`, [await id("Aa"), await id("Cc")]);
const ab = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-keep', 'merge', $1, 'Aa', $2, 'Bb', 'claude') returning id`, [await id("Aa"), await id("Bb")])).id;
await db.query(`select apply_entity_edit($1)`, [ab]);
const cd = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-keep', 'merge', $1, 'Cc', $2, 'Dd', 'claude') returning id`, [await id("Cc"), await id("Dd")])).id;
await db.query(`select apply_entity_edit($1)`, [cd]);
await assert.rejects(db.query(`select undo_entity_edit($1)`, [ab]), /later applied edits/, "a shared staged judgment orders the undos");
await db.query(`select undo_entity_edit($1)`, [cd]);
await db.query(`select undo_entity_edit($1)`, [ab]);
assert.deepEqual((await one(`select entity_name, into_name from entity_edits where batch = 'qa-keep' and op = 'keep'`)), { entity_name: "Aa", into_name: "Cc" }, "and the judgment is as staged");


// Two in one transaction: undo order follows application, not staging ids.
const orderBefore = await dump();
const [a, b] = [
  (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
    values ('qa-order', 'merge', $1, 'Salle Une', $2, 'Salle 1', 'claude') returning id`, [await id("Salle Une"), await id("Salle 1")])).id,
  (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by)
    values ('qa-order', 'merge', $1, 'Palais', $2, 'Le Palais', 'claude') returning id`, [await id("Palais"), await id("Le Palais")])).id,
];
await db.exec(`begin; select apply_entity_edit(${b}); select apply_entity_edit(${a}); commit;`);
await assert.rejects(db.query(`select undo_entity_edit($1)`, [b]), /later applied edits/, "applied later in the same transaction counts as later");
await db.query(`select undo_entity_edit($1)`, [a]);
await db.query(`select undo_entity_edit($1)`, [b]);
assert.deepEqual(await dump(), orderBefore, "and both undo exactly");

// Merging a place into the place it lies in undoes at once; and a later merge
// of a place the merged-away one was in must be undone first.
await db.exec(`insert into entities (name, kind) values ('Quartier','place'), ('Rue','place'), ('Ville','place'), ('Cité','place')`);
await place(await id("Quartier"), await id("Ville"));
await place(await id("Rue"), await id("Quartier"));
const inner = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-anc', 'merge', $1, 'Rue', $2, 'Quartier', 'claude') returning id`, [await id("Rue"), await id("Quartier")])).id;
await db.query(`select apply_entity_edit($1)`, [inner]);
await db.query(`select undo_entity_edit($1)`, [inner]);
assert.equal((await one(`select place_within($1, $2) b`, [await id("Rue"), await id("Quartier")])).b, true, "an immediate undo of a merge into its own container works");
const viaAnc = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-anc', 'merge', $1, 'Rue', $2, 'Cité', 'claude') returning id`, [await id("Rue"), await id("Cité")])).id;
await db.query(`select apply_entity_edit($1)`, [viaAnc]);
const ancMerge = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-anc', 'merge', $1, 'Quartier', $2, 'Ville', 'claude') returning id`, [await id("Quartier"), await id("Ville")])).id;
await db.query(`select apply_entity_edit($1)`, [ancMerge]);
await assert.rejects(db.query(`select undo_entity_edit($1)`, [viaAnc]), /later applied edits/, "an ancestor merged later orders the undos");
await db.query(`select undo_entity_edit($1)`, [ancMerge]);
await db.query(`select undo_entity_edit($1)`, [viaAnc]);
assert.equal((await one(`select place_within($1, $2) b`, [await id("Rue"), await id("Quartier")])).b, true, "and Rue is back inside Quartier");

// The merged-away entity's own ancestors order the undos even when nothing
// else links the two merges (A in P, B in unrelated Q; A→B, then P→R).
await db.exec(`insert into entities (name, kind) values ('PP','place'), ('QQ','place'), ('RR','place'), ('AA','place'), ('BB','place')`);
await place(await id("AA"), await id("PP"));
await place(await id("BB"), await id("QQ"));
const aToB = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-anc2', 'merge', $1, 'AA', $2, 'BB', 'claude') returning id`, [await id("AA"), await id("BB")])).id;
await db.query(`select apply_entity_edit($1)`, [aToB]);
const pToR = (await one(`insert into entity_edits (batch, op, entity_id, entity_name, into_id, into_name, decided_by) values ('qa-anc2', 'merge', $1, 'PP', $2, 'RR', 'claude') returning id`, [await id("PP"), await id("RR")])).id;
await db.query(`select apply_entity_edit($1)`, [pToR]);
await assert.rejects(db.query(`select undo_entity_edit($1)`, [aToB]), /later applied edits/, "merging away a former ancestor orders the undos");
await db.query(`select undo_entity_edit($1)`, [pToR]);
await db.query(`select undo_entity_edit($1)`, [aToB]);
assert.equal((await one(`select place_within($1, $2) b`, [await id("AA"), await id("PP")])).b, true, "AA is back inside PP");

console.log("entity_sense: all checks pass");
