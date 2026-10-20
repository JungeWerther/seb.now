import { assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { linksToEnrich, markEnriched } from "./enrich.ts";
import { sumBy } from "./helpers.ts";

// Just enough of a client: links_to_enrich answers `order`, links come back
// in `stored` order, and every upsert is recorded.
function stubDb(order: string[], stored: { id: string }[]) {
  const upserts: unknown[] = [];
  const db = {
    rpc: () => Promise.resolve({ data: order.map((link_id) => ({ link_id })), error: null }),
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: stored, error: null }) }),
      upsert: (rows: unknown) => (upserts.push(rows), Promise.resolve({ error: null })),
    }),
  };
  return { db: db as unknown as SupabaseClient, upserts };
}

Deno.test("linksToEnrich keeps links_to_enrich's order and skips links gone since", async () => {
  const { db } = stubDb(["c", "a", "gone", "b"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assertEquals((await linksToEnrich(db, "topics", 4, "id")).map((l) => l.id), ["c", "a", "b"]);
});

Deno.test("markEnriched stamps the step's column once per link, and nothing for none", async () => {
  const { db, upserts } = stubDb([], []);
  await markEnriched(db, "page_entities", []);
  assertEquals(upserts, []);
  await markEnriched(db, "page_entities", ["a", "b"]);
  const [rows] = upserts as { link_id: string; page_entities_at: string }[][];
  assertEquals(rows.map((r) => r.link_id), ["a", "b"]);
  assertEquals(new Set(rows.map((r) => r.page_entities_at)).size, 1);
});

Deno.test("sumBy sums a numeric field or a function of each item", () => {
  const items = [{ n: 1, xs: [1, 2] }, { n: 2, xs: [] }];
  assertEquals(sumBy(items, "n"), 3);
  assertEquals(sumBy(items, (i) => i.xs.length), 2);
  assertEquals(sumBy(items.slice(2), "n"), 0);
});
