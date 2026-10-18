// Runs the compiled prelude.js, as the page does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/seb_now/templates/prelude.js", import.meta.url), "utf8");
const { Result, fieldOf, match } = vm.runInNewContext(`${source}\n;({ Result, fieldOf, match })`);

const plain = (x) => JSON.parse(JSON.stringify(x));
const down = { message: "down" };

test("map and chain run only on a value", async () => {
  assert.deepEqual(plain(Result.map(Result.ok(2), (x) => x + 1)), { data: 3, error: null });
  assert.equal(Result.map(Result.fail(down), () => assert.fail()).error, down);
  assert.deepEqual(plain(await Result.chain(Result.ok(2), async (x) => Result.ok(x * 2))), { data: 4, error: null });
  assert.equal((await Result.chain(Promise.resolve(Result.fail(down)), () => assert.fail())).error, down);
  assert.equal((await Result.chain(Result.ok(1), () => Result.fail(down))).error, down);
});

test("a supabase-shaped response is a Result", () => {
  assert.equal(Result.isOk({ data: [], error: null }), true);
  assert.equal(Result.isOk({ data: null, error: down }), false);
});

test("unwrapOr hands the failure to its handler", () => {
  const seen = [];
  assert.equal(Result.unwrapOr(Result.ok(1), 0, (e) => seen.push(e)), 1);
  assert.equal(Result.unwrapOr(Result.fail(down), 0, (e) => seen.push(e)), 0);
  assert.deepEqual(seen, [down]);
});

test("attempt and settle never reject", async () => {
  assert.deepEqual(plain(await Result.attempt(Promise.resolve(1))), { data: 1, error: null });
  assert.equal((await Result.attempt(Promise.reject(down))).error, down);
  assert.equal((await Result.settle(Promise.reject("why"))).error.message, "why");
});

test("match picks the case for the value's field", () => {
  const cases = { kind: ({ kind }) => `k ${kind}`, topic: ({ topic }) => `t ${topic}` };
  assert.equal(match(cases, { topic: "ai" }), "t ai");
  assert.equal(fieldOf(cases, { kind: "x", label: "y" }), "kind");
  assert.throws(() => match(cases, { other: 1 }), { name: "TypeError" });
});
