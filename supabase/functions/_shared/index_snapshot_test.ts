import { assertEquals } from "jsr:@std/assert@1";
import { decodeSnapshot, deltas, encodeSnapshot, type RawSnapshot, undeltas } from "./index_snapshot.ts";

Deno.test("deltas round-trip", () => {
  assertEquals(deltas([5, 7, 7, 20]), [5, 2, 0, 13]);
  assertEquals(undeltas([5, 2, 0, 13]), [5, 7, 7, 20]);
  assertEquals(undeltas(deltas([])), []);
});

Deno.test("a snapshot round-trips, with each link's entities sorted", () => {
  const raw: RawSnapshot = {
    v: 1,
    gen: 3,
    wm: { l: 40, e: 90, p: 400 },
    kinds: [["entity.event", "event"], ["entity.place", "place"]],
    entities: { seq: [10, 11, 50], name: ["Paris", "Fête", "Lyon"], kind: [1, 0, 1] },
    links: { seq: [3, 9], minute: [29000000, 29000100], entities: [[50, 10], [11]] },
  };
  const encoded = encodeSnapshot(raw);
  assertEquals(encoded.entities.seq, [10, 1, 39]);
  assertEquals(encoded.links.entities, [[10, 40], [11]]);
  assertEquals(decodeSnapshot(encoded), { ...raw, links: { ...raw.links, entities: [[10, 50], [11]] } });
});
