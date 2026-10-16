// The compiled script is what the page runs, so it's what these tests load:
// evaluated in a fresh context, its declarations returned by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/seb_now/templates/filter.js", import.meta.url), "utf8");
const { Filter, filterKey, filterPageKey, nextFilterCursor, memoizePages } = vm.runInNewContext(
  `${source}\n;({ Filter, filterKey, filterPageKey, nextFilterCursor, memoizePages })`,
  { setTimeout },
);

// Values from the context have its prototypes; compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

const event = Filter.kind("entity.event", { kind: "kind", label: "Event" });
const paris = Filter.entities(["b", "a"], { kind: "place", label: "Paris" });
const read = (...filters) => filters.reduce(Filter.concat, Filter.unit());

test("unit is the identity of concat", () => {
  assert.deepEqual(Filter.concat(Filter.unit(), event), event);
  assert.deepEqual(Filter.concat(event, Filter.unit()), event);
});

test("concat is associative and keeps the log in order", () => {
  const left = Filter.concat(Filter.concat(event, paris), event);
  const right = Filter.concat(event, Filter.concat(paris, event));
  assert.deepEqual(left, right);
  assert.deepEqual(plain(left.log.map((c) => c.label)), ["Event", "Paris", "Event"]);
});

test("the key ignores order, repeats and the log", () => {
  assert.equal(filterKey(read(event, paris)), filterKey(read(paris, event)));
  assert.equal(filterKey(read(event, paris, event)), filterKey(read(event, paris)));
  assert.equal(filterKey(paris), filterKey(Filter.entities(["a", "b"], { kind: "x", label: "y" })));
  assert.notEqual(filterKey(event), filterKey(paris));
});

test("pages of one filter have different keys", () => {
  const f = read(event, paris);
  const cursor = nextFilterCursor([{ link_id: "L", entity_ids: [], created_at: "2026-10-16T00:00:00Z" }]);
  assert.deepEqual(plain(cursor), { createdAt: "2026-10-16T00:00:00Z", id: "L" });
  assert.notEqual(filterPageKey(f, null), filterPageKey(f, cursor));
  assert.equal(nextFilterCursor([]), null);
});

test("a page in flight is shared, then served from the cache", async () => {
  let calls = 0;
  const load = memoizePages((k) => k, async (k) => { calls++; return `page ${k}`; });
  const [a, b] = await Promise.all([load("x"), load("x")]);
  assert.equal(a, "page x");
  assert.equal(b, "page x");
  await load("x");
  assert.equal(calls, 1);
});

test("failed loads aren't cached", async () => {
  let calls = 0;
  const load = memoizePages((k) => k, async () => { calls++; return calls === 1 ? null : "ok"; });
  assert.equal(await load("x"), null);
  assert.equal(await load("x"), "ok");
  const rejecting = memoizePages((k) => k, async () => { calls++; throw new Error("down"); });
  await assert.rejects(rejecting("y"));
  await assert.rejects(rejecting("y"));
  assert.equal(calls, 4);
});

test("pages expire and the least recently used is evicted", async () => {
  let clock = 0;
  let calls = 0;
  const load = memoizePages((k) => k, async (k) => { calls++; return k; }, { ttlMs: 10, maxEntries: 2, now: () => clock });
  await load("a");
  await load("b");
  await load("a"); // a is now the most recently used
  await load("c"); // evicts b
  assert.equal(calls, 3);
  await load("b");
  assert.equal(calls, 4);
  clock = 11;
  await load("a");
  assert.equal(calls, 5);
});
