import { assertEquals } from "jsr:@std/assert@1";
import { bearer, mergePlan, mergeRefusal } from "./account_merge.ts";

const anon = { id: "a", is_anonymous: true };
const account = { id: "b", is_anonymous: false };

Deno.test("an anonymous session merges into a real account", () => {
  assertEquals(mergeRefusal(anon, account), null);
  assertEquals(mergePlan(anon, account), { from: "a", into: "b" });
});

Deno.test("the caller must be a real account", () => {
  assertEquals(mergeRefusal(anon, { id: "c", is_anonymous: true })?.status, 403);
  assertEquals(mergeRefusal(anon, { id: "c" })?.status, 403);
});

Deno.test("only an anonymous session is merged away", () => {
  assertEquals(mergeRefusal({ id: "c", is_anonymous: false }, account)?.status, 409);
  assertEquals(mergeRefusal({ id: "c" }, account)?.status, 409);
});

Deno.test("a session is not merged into itself", () => {
  assertEquals(mergeRefusal({ id: "b", is_anonymous: true }, { id: "b", is_anonymous: false })?.status, 409);
});

Deno.test("bearer reads an Authorization header", () => {
  assertEquals(bearer("Bearer abc.def"), "abc.def");
  assertEquals(bearer("bearer x"), "x");
  assertEquals(bearer("Basic x"), null);
  assertEquals(bearer(null), null);
});
