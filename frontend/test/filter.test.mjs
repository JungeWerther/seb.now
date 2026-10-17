// The compiled script is what the page runs, so it's what these tests load:
// evaluated in a fresh context, its declarations returned by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/seb_now/templates/filter.js", import.meta.url), "utf8");
const { Filter, filterKey, filterPageKey, nextFilterCursor, memoize } = vm.runInNewContext(
  `${source}\n;({ Filter, filterKey, filterPageKey, nextFilterCursor, memoize })`,
  { setTimeout },
);

// Values from the context have its prototypes; compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

const event = Filter.term([{ kind: "entity.event" }], "event", ["kind"], [{ kind: "entity.event" }]);
const paris = Filter.term([{ entities: ["b", "a"] }], "Paris", ["place"], [{ seqs: [2, 1] }]);
const tonight = Filter.term([{ indexical: "tonight", at: "2026-10-16T21:00" }], "tonight", ["period"], null);
const read = (...filters) => filters.reduce(Filter.concat, Filter.unit());

test("unit is the identity of concat", () => {
  assert.deepEqual(plain(Filter.concat(Filter.unit(), event)), plain(event));
  assert.deepEqual(plain(Filter.concat(event, Filter.unit())), plain(event));
});

test("concat is associative and keeps the log in order", () => {
  const left = Filter.concat(Filter.concat(event, paris), event);
  const right = Filter.concat(event, Filter.concat(paris, event));
  assert.deepEqual(plain(left), plain(right));
  assert.deepEqual(plain(left.log.map((c) => c.label)), ["event", "Paris", "event"]);
});

test("a term's senses are a disjunction, sent bare when there's one", () => {
  const film = Filter.term([{ kind: "entity.event" }, { entities: ["f"] }], "Tonight", ["kind", "work", "kind"], null);
  assert.deepEqual(plain(film.terms), [{ any: [{ kind: "entity.event" }, { entities: ["f"] }] }]);
  assert.deepEqual(plain(film.log), [{ kind: "kind / work", label: "Tonight" }]);
  assert.deepEqual(plain(event.terms), [{ kind: "entity.event" }]);
});

test("a filter can be read locally only if every term can", () => {
  assert.deepEqual(plain(read(event, paris).local), [{ kind: "entity.event" }, { seqs: [2, 1] }]);
  assert.equal(read(event, tonight).local, null);
  assert.equal(read(tonight, event).local, null);
});

test("the key ignores order, repeats, sense order and the log", () => {
  assert.equal(filterKey(read(event, paris)), filterKey(read(paris, event)));
  assert.equal(filterKey(read(event, paris, event)), filterKey(read(event, paris)));
  assert.equal(filterKey(paris), filterKey(Filter.term([{ entities: ["a", "b"] }], "y", ["x"], null)));
  const ab = Filter.term([{ kind: "entity.event" }, { topic: "culture.cinema" }], "a", [], null);
  const ba = Filter.term([{ topic: "culture.cinema" }, { kind: "entity.event" }], "b", [], null);
  assert.equal(filterKey(ab), filterKey(ba));
  assert.notEqual(filterKey(event), filterKey(paris));
});

test("an indexical read at another time is another filter", () => {
  const later = Filter.term([{ indexical: "tonight", at: "2026-10-17T21:00" }], "tonight", ["period"], null);
  assert.notEqual(filterKey(tonight), filterKey(later));
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
  const load = memoize((k) => k, async (k) => { calls++; return `page ${k}`; });
  const [a, b] = await Promise.all([load("x"), load("x")]);
  assert.equal(a, "page x");
  assert.equal(b, "page x");
  await load("x");
  assert.equal(calls, 1);
});

test("failed loads aren't cached", async () => {
  let calls = 0;
  const load = memoize((k) => k, async () => { calls++; return calls === 1 ? null : "ok"; });
  assert.equal(await load("x"), null);
  assert.equal(await load("x"), "ok");
  const rejecting = memoize((k) => k, async () => { calls++; throw new Error("down"); });
  await assert.rejects(rejecting("y"));
  await assert.rejects(rejecting("y"));
  assert.equal(calls, 4);
});

test("pages expire and the least recently used is evicted", async () => {
  let clock = 0;
  let calls = 0;
  const load = memoize((k) => k, async (k) => { calls++; return k; }, { ttlMs: 10, maxEntries: 2, now: () => clock });
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
