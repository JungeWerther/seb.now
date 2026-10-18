import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { lazy, memoize, once } from "./memo.ts";

Deno.test("once shares one load and retries after a failure", async () => {
  let calls = 0;
  const load = once(() => ++calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve(calls));
  await assertRejects(load, Error, "down");
  assertEquals(await Promise.all([load(), load()]), [2, 2]);
  assertEquals(calls, 2);
});

Deno.test("memoize shares a load in flight and forgets null and failures", async () => {
  let calls = 0;
  const load = memoize((k: string) => k, (k) => {
    calls++;
    if (k === "boom") return Promise.reject(new Error("down"));
    return Promise.resolve(k === "none" ? null : `value ${k}`);
  }, { maxEntries: 10 });
  assertEquals(await Promise.all([load("a"), load("a")]), ["value a", "value a"]);
  assertEquals(calls, 1);
  await load("none");
  await load("none");
  assertEquals(calls, 3);
  await assertRejects(() => load("boom"));
  await assertRejects(() => load("boom"));
  assertEquals(calls, 5);
});

Deno.test("memoize drops the least recently used entry and takes primed values", async () => {
  let calls = 0;
  const load = memoize((k: string) => k, (k) => Promise.resolve(`${k}${++calls}`), { maxEntries: 2 });
  await load("a");
  await load("b");
  await load("a");
  await load("c");
  assertEquals(await load("a"), "a1");
  assertEquals(await load("b"), "b4");
  load.prime(["z"], "primed");
  assertEquals(await load("z"), "primed");
});

Deno.test("priming with null keeps nothing, so the next call loads", async () => {
  let calls = 0;
  const load = memoize((k: string) => k, () => Promise.resolve<string | null>(`loaded ${++calls}`), { maxEntries: 2 });
  load.prime(["a"], null);
  assertEquals(await load("a"), "loaded 1");
  load.prime(["a"], null);
  assertEquals(await load("a"), "loaded 2");
});

Deno.test("lazy makes its value once, on first use", () => {
  let calls = 0;
  const value = lazy(() => ++calls);
  assertEquals(calls, 0);
  assertEquals([value(), value()], [1, 1]);
});
