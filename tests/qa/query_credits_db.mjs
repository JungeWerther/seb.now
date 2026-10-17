// Local QA of 20261018000200_refund_query_credit.sql on an embedded Postgres:
// a refund gives back exactly one read, never takes `used` below 0, touches
// only the named user, and only service_role may run it.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const migrations = process.argv.slice(2);
const db = new PGlite();

await db.exec(`
create schema auth;
create table auth.users (id uuid primary key);
create role anon; create role authenticated; create role service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
`);
for (const m of migrations) await db.exec(readFileSync(m, "utf8"));

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const as = async (role, uid, sql, params = []) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role;");
  }
};
const used = async (uid) => (await db.query("select used from query_credits where user_id = $1", [uid])).rows[0]?.used ?? null;
const refund = async (uid) => (await as("service_role", null, "select refund_query_credit($1) left", [uid]))[0].left;

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const refused = async (role, uid, sql) => {
  try {
    await as(role, uid, sql);
    return false;
  } catch {
    return true;
  }
};

check("no row yet: refund is null and creates nothing", [await refund(A), await used(A)], [null, null]);
for (let i = 0; i < 3; i++) await as("authenticated", A, "select spend_query_credit()");
await as("authenticated", B, "select spend_query_credit()");
check("A spent 3", await used(A), 3);
check("refund returns what's left after it", await refund(A), 998);
check("and takes exactly one off", await used(A), 2);
check("B is untouched", await used(B), 1);
await refund(A);
await refund(A);
check("down to 0", await used(A), 0);
check("a refund at 0 stays at 0", [await refund(A), await used(A)], [1000, 0]);
check("authenticated can't refund", await refused("authenticated", A, `select refund_query_credit('${A}')`), true);
check("anon can't refund", await refused("anon", null, `select refund_query_credit('${A}')`), true);
check("authenticated still can't write the table", await refused("authenticated", A, "update query_credits set used = 0"), true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
