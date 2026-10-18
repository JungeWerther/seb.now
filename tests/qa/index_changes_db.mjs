// Local QA of the entity-index change log on an embedded Postgres shaped like
// ours: runs the entity index migrations, then index_changes, and checks that a
// copy built from a snapshot and brought up to date by the page's own
// applyIndexDiff (pulled out of the template verbatim) after deletions, renames,
// moves (a merge) and deleted links equals a fresh snapshot; that asking again
// from below the watermark changes nothing; that gen still moves for older
// pages while reset_gen only moves on a bump the log can't carry; and that
// pruning the log makes a page far behind reload. Takes the page template,
// then the migrations to run, in order.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [template, ...migrations] = process.argv.slice(2);
const html = readFileSync(template, "utf8");

// The source of a top-level `function name(...) {...}` or `const name = ...;`.
function grab(name) {
  const fn = html.search(new RegExp(`\\n    (async )?function ${name}\\(`));
  const cst = html.search(new RegExp(`\\n    (const|let) ${name}\\b`));
  const start = fn >= 0 ? fn : cst;
  if (start < 0) throw new Error(`missing ${name}`);
  let i = fn >= 0 ? html.indexOf(") {\n", start) + 2 : html.indexOf("=", start);
  let depth = 0;
  if (fn < 0) {
    for (; i < html.length; i++) {
      const c = html[i];
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      else if (c === ";" && depth === 0) return html.slice(start, i + 1);
    }
  }
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const names = ["INDEX_LITTLE_WORDS", "FOLD_LETTERS", "entityIndex", "foldName", "indexEntity", "indexMention",
  "loadIndexState", "indexCopyCurrent", "unindexMention", "applyIndexDiff"];
const page = new Function(names.map(grab).join("\n") + `
return { entityIndex, loadIndexState, applyIndexDiff, indexCopyCurrent };`)();
const { entityIndex } = page;

const db = new PGlite({ extensions: { ltree } });
await db.exec(`
create schema extensions;
create extension ltree schema extensions;
set search_path = public, extensions;
create role anon; create role authenticated;
create schema cron;
create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create function public.app_setting(k text) returns text language sql as $$ select ''::text $$;
create table public.kinds (path extensions.ltree primary key);
insert into kinds values ('entity'),('entity.place'),('entity.agent'),('entity.agent.org');
create table public.entities (
  id uuid primary key default gen_random_uuid(), name text not null, kind text not null,
  kind_path extensions.ltree references kinds(path)
);
create table public.links (id uuid primary key default gen_random_uuid(), title text, created_at timestamptz not null default now());
create table public.link_entities (
  link_id uuid not null references links(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  p real not null default 1, primary key (link_id, entity_id)
);
`);
for (const file of migrations) await db.exec(readFileSync(file, "utf8"));

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const state = () => one(`select gen, reset_gen, changes_pruned_seq from index_state`);
const snapshot = async () => (await one(`select index_snapshot() as s`)).s;
const diffFrom = async (wm, overlap = 0) => (await one(
  `select index_diff($1, $2, $3, $4) as d`,
  [Math.max(0, wm.l - overlap), Math.max(0, wm.e - overlap), Math.max(0, wm.p - overlap), Math.max(0, wm.c - overlap)],
)).d;

// The index in a comparable shape: entity seq → [name, kind_path, kind], link seq → [minute, entity seqs].
function canon() {
  return {
    entities: Object.fromEntries([...entityIndex.entities].map(([seq, e]) => [seq, [e.name, e.kind_path, e.kind]]).sort((a, b) => a[0] - b[0])),
    links: Object.fromEntries([...entityIndex.links].map(([seq, l]) => [seq, [l.minute, [...l.entities].sort((a, b) => a - b)]]).sort((a, b) => a[0] - b[0])),
  };
}
async function fresh() {
  page.loadIndexState(await snapshot());
  return canon();
}

await db.exec(`
insert into entities (name, kind, kind_path) values
  ('Paris','place','entity.place'), ('Tokyo','place','entity.place'), ('Palais de Tokyo','place','entity.place'),
  ('OpenAI','company','entity.agent.org'), ('Open AI','company','entity.agent.org'), ('Uber','company','entity.agent.org');
insert into links (title) values ('a'), ('b'), ('c'), ('d');
insert into link_entities (link_id, entity_id)
select l.id, e.id from links l, entities e
where (l.title, e.name) in (('a','Paris'),('a','Tokyo'),('a','Palais de Tokyo'),('b','OpenAI'),('c','Open AI'),('b','Open AI'),('d','Uber'),('c','Paris'));
`);

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}\n${error.stack}`);
  }
}

const start = await state();

await check("the snapshot carries a change watermark", async () => {
  const s = await snapshot();
  assert.equal(typeof s.wm.c, "number");
});

await check("a mention move, deletion, rename and deleted entity and link reach a copy as a diff", async () => {
  page.loadIndexState(await snapshot());
  const before = await state();
  await db.exec(`
    -- "Tokyo" read out of "Palais de Tokyo"
    delete from link_entities where entity_id = (select id from entities where name = 'Tokyo');
    -- merge Open AI into OpenAI: repoint, drop the collision, delete
    delete from link_entities le using links l where le.link_id = l.id and l.title = 'b'
      and le.entity_id = (select id from entities where name = 'Open AI');
    update link_entities set entity_id = (select id from entities where name = 'OpenAI')
      where entity_id = (select id from entities where name = 'Open AI');
    delete from entities where name = 'Open AI';
    update entities set name = 'Paris, France' where name = 'Paris';
    update entities set kind_path = 'entity.agent', kind = 'other' where name = 'Uber';
    delete from links where title = 'd';
    insert into entities (name, kind, kind_path) values ('Lyon','place','entity.place');
    insert into links (title) values ('e');
    insert into link_entities (link_id, entity_id) select l.id, e.id from links l, entities e where l.title = 'e' and e.name = 'Lyon';
    -- an upsert that rewrites p only isn't a change
    update link_entities set p = 0.5;
  `);
  const after = await state();
  assert.ok(after.gen > before.gen, "gen still moves for older pages");
  assert.equal(after.reset_gen, before.reset_gen, "nothing here needs a reload");
  const diff = await diffFrom(entityIndex.wm);
  assert.equal(diff.reload, false);
  assert.ok(page.indexCopyCurrent(diff));
  page.applyIndexDiff(diff);
  const applied = canon();
  const wm = entityIndex.wm;
  assert.deepEqual(applied, await fresh());

  // Asked again from far below the watermark: the same copy.
  page.loadIndexState({ ...(await snapshot()), wm });
  const again = await diffFrom(wm, 500);
  page.applyIndexDiff(again);
  assert.deepEqual(canon(), applied);
});

await check("an old diff applied over a newer copy doesn't undo a re-added mention", async () => {
  page.loadIndexState(await snapshot());
  const wm0 = entityIndex.wm;
  await db.exec(`delete from link_entities le using links l, entities e
    where le.link_id = l.id and le.entity_id = e.id and l.title = 'a' and e.name = 'Palais de Tokyo'`);
  page.applyIndexDiff(await diffFrom(entityIndex.wm));
  await db.exec(`insert into link_entities (link_id, entity_id)
    select l.id, e.id from links l, entities e where l.title = 'a' and e.name = 'Palais de Tokyo'`);
  page.applyIndexDiff(await diffFrom(entityIndex.wm));
  // the overlap re-sends the old deletion: it now answers with the pair as it is
  page.applyIndexDiff(await diffFrom(wm0));
  assert.deepEqual(canon(), await fresh());
});

await check("a gen bump outside the log moves reset_gen, and the copy reloads", async () => {
  page.loadIndexState(await snapshot());
  await db.exec(`update index_state set gen = gen + 1 where id`);
  const s = await state();
  assert.equal(s.reset_gen, s.gen);
  const diff = await diffFrom(entityIndex.wm);
  assert.equal(page.indexCopyCurrent(diff), false);
  page.loadIndexState(await snapshot());
  assert.ok(page.indexCopyCurrent(await diffFrom(entityIndex.wm)));
});

await check("an undo's own bump still resets after logged changes in the same transaction", async () => {
  const before = await state();
  await db.exec(`
    begin;
    update entities set name = 'Lyon, France' where name = 'Lyon';
    update index_state set gen = gen + 1 where id;
    commit;
  `);
  const after = await state();
  assert.equal(after.gen, before.gen + 2);
  assert.equal(after.reset_gen, after.gen);
});

await check("a copy without a change watermark goes by gen, and takes one on", async () => {
  const s = await snapshot();
  delete s.wm.c;
  page.loadIndexState(s);
  const legacy = (await one(`select index_diff($1, $2, $3) as d`, [s.wm.l, s.wm.e, s.wm.p])).d;
  assert.equal(legacy.unpairs, undefined, "an older page's diff is as it was");
  assert.ok(page.indexCopyCurrent(legacy));
  page.applyIndexDiff(legacy);
  assert.equal(typeof entityIndex.wm.c, "number");
  await db.exec(`delete from link_entities le using links l where le.link_id = l.id and l.title = 'c'`);
  page.loadIndexState(s);
  const stale = (await one(`select index_diff($1, $2, $3) as d`, [s.wm.l, s.wm.e, s.wm.p])).d;
  assert.equal(page.indexCopyCurrent(stale), false, "gen moved, so an older copy reloads");
});

await check("pruning the log makes a page far behind reload", async () => {
  const wm = (await snapshot()).wm;
  await db.exec(`
    insert into index_changes (entity_seq) select 1 from generate_series(1, 12000);
    select index_snapshot_published('snapshots/x.json.gz', 1, 0, 0, 0);
  `);
  const s = await state();
  assert.ok(s.changes_pruned_seq > wm.c);
  assert.equal((await one(`select count(*)::int as n from index_changes`)).n, 10000);
  assert.equal((await diffFrom(wm)).reload, true);
  const now = (await snapshot()).wm;
  assert.equal((await diffFrom(now, 500)).reload, false);
});

await check("the migration bumped gen once as a reset", async () => {
  assert.equal(start.reset_gen, start.gen);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
