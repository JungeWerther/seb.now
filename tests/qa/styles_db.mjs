// Local QA of the AAT style topics migration, on a topics table shaped like
// production: it applies (twice, since it upserts), every topic's parent
// exists, and the familiar styles land where expected.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { readFileSync } from "node:fs";

const [migration] = process.argv.slice(2);
const db = new PGlite({ extensions: { ltree } });

await db.exec(`
create extension ltree;
create schema extensions;
create table public.topics (
  id ltree primary key,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  proposed_by uuid,
  jel_code text check (jel_code ~ '^[A-Z]([0-9]{1,2})?$')
);
insert into topics (id, name, description) values ('culture', 'Culture', 'Arts, history and the humanities.');
`);

const sql = readFileSync(migration, "utf8").replaceAll("extensions.ltree", "ltree");
await db.exec(sql);
await db.exec(sql.replace(/alter table public\.topics\s+add column aat_id[^;]+;/, ""));

const one = async (q) => (await db.query(q)).rows;
const fail = (msg) => {
  console.error("FAIL", msg);
  process.exitCode = 1;
};

const [{ n, depth }] = await one(`select count(*)::int n, max(nlevel(id)) depth from topics where id <@ 'culture.styles'`);
console.log(`${n} style topics, max depth ${depth}`);

const orphans = await one(`
  select t.id::text from topics t
  where nlevel(t.id) > 1 and not exists (select 1 from topics p where p.id = subpath(t.id, 0, nlevel(t.id) - 1))`);
if (orphans.length) fail(`topics without a parent: ${orphans.map((r) => r.id).join(", ")}`);

const missingAat = await one(`select id::text from topics where id <@ 'culture.styles' and aat_id is null`);
if (missingAat.length) fail(`style topics without an aat_id: ${missingAat.map((r) => r.id).join(", ")}`);

const expected = {
  300112048: ["Brutalism", "culture.styles.post_1945_architecture_design"],
  300021495: ["Cubism", "culture.styles.modern_european.fine_arts"],
  300021432: ["Bauhaus", "culture.styles"],
  300021147: ["Baroque", "culture.styles.renaissance_baroque"],
  300022205: ["Pop art", "culture.styles.post_1945_fine_arts"],
};
for (const [aat, [name, under]] of Object.entries(expected)) {
  const rows = await one(`select id::text, name from topics where aat_id = '${aat}' and '${under}' @> id`);
  if (!rows.length || rows.some((r) => r.name !== name)) fail(`AAT ${aat}: expected ${name} under ${under}, got ${JSON.stringify(rows)}`);
}

// Only leaves are labelled, so a style with substyles needs a leaf for itself.
for (const aat of ["300021495", "300021512", "300021514", "300020775", "300021147"]) {
  const rows = await one(`
    select p.id::text from topics p
    where p.aat_id = '${aat}' and not p.id ~ '*.general'
      and not exists (select 1 from topics g where g.id = p.id || 'general'::ltree and g.aat_id = p.aat_id)`);
  if (rows.length) fail(`AAT ${aat} has substyles but no .general leaf: ${rows.map((r) => r.id).join(", ")}`);
}

const peoples = await one(`select id::text from topics where id <@ 'culture.styles' and description like 'Culture and style of%'`);
if (peoples.length) fail(`peoples imported as styles: ${peoples.map((r) => r.id).join(", ")}`);

if (!process.exitCode) console.log("ok");
