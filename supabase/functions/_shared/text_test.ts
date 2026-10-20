import { assertEquals } from "jsr:@std/assert@1";
import { errorMessage, stripTags, truncate } from "./text.ts";

Deno.test("truncate keeps short text and cuts long text at a word, ellipsis included", () => {
  assertEquals(truncate("short", 5), "short");
  assertEquals(truncate("one two three", 10), "one two…");
  assertEquals(truncate("one two three", 10).length <= 10, true);
  assertEquals(truncate("abcdefghijkl", 6), "abcde…");
});

Deno.test("truncate without atWord cuts right at the limit", () => {
  assertEquals(truncate("one two three", 10, { atWord: false }), "one two t…");
});

Deno.test("stripTags drops tags, or replaces them with a separator", () => {
  assertEquals(stripTags("<b>Bold</b> <i>move</i>"), "Bold move");
  assertEquals(stripTags("<p>a</p><p>b</p>", " "), " a  b ");
});

Deno.test("errorMessage reads an Error's message and stringifies anything else", () => {
  assertEquals(errorMessage(new Error("down")), "down");
  assertEquals(errorMessage("plain"), "plain");
  assertEquals(errorMessage(404), "404");
});
