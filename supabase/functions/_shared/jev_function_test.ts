import { assertEquals } from "jsr:@std/assert@1";
import { isPresent, reporting, serveJev } from "./jev_function.ts";
import { pool } from "./pool.ts";

Deno.test("pool keeps input order and never runs more than its size at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await pool([30, 10, 20, 0], 2, async (ms) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return ms * 2;
  });
  assertEquals(out, [60, 20, 40, 0]);
  assertEquals(peak, 2);
});

Deno.test("reporting turns a throw into a reported null", async () => {
  const errors: unknown[] = [];
  const run = reporting((e) => errors.push(e), (n: number) => ({ n }), (n) => {
    if (n < 0) throw new Error("negative");
    return Promise.resolve(n);
  });
  assertEquals((await Promise.all([1, -1, 2].map(run))).filter(isPresent), [1, 2]);
  assertEquals(errors, [{ n: -1, error: "Error: negative" }]);
});

Deno.test("serveJev rejects malformed link_ids before touching the database", async () => {
  const handler = serveJev({ fn: "test", model: "m", maxLinkIds: 2 }, () => Promise.resolve({}));
  for (const link_ids of [["a", "b", "c"], "a", [1]]) {
    const res = await handler(new Request("http://x", { method: "POST", body: JSON.stringify({ link_ids }) }));
    assertEquals(res.status, 400);
    await res.body?.cancel();
  }
});
