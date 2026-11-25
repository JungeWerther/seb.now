import { assertEquals } from "jsr:@std/assert@1";
import { mergeDirection } from "./merge_direction.ts";

const place = { id: "p", name: "Persian Gulf" };
const holder = { id: "h", name: "Perzische Golf" };

Deno.test("keeps the entity named by the item's label", () => {
  assertEquals(mergeDirection(place, holder, "Persian Gulf"), { from: holder, into: place });
});

Deno.test("keeps the holder when it is the one named by the label", () => {
  assertEquals(mergeDirection(holder, place, "Persian Gulf"), { from: holder, into: place });
});

Deno.test("keeps the holder when neither or both match", () => {
  assertEquals(mergeDirection(place, holder, "Gulf of Persia"), { from: place, into: holder });
  assertEquals(mergeDirection(place, { id: "h", name: "persian gulf" }, "Persian Gulf").into.id, "h");
  assertEquals(mergeDirection(place, holder, null), { from: place, into: holder });
});

Deno.test("ignores case and accents", () => {
  const vesuve = { id: "v", name: "Vésuve" };
  assertEquals(mergeDirection(vesuve, { id: "m", name: "Mount Vesuvius" }, "vesuve").into, vesuve);
});
