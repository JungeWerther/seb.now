import { assertEquals } from "jsr:@std/assert@1";
import { decodeEntities, extractTag, httpUrl, mapSeries, pastDate, present } from "./ingest.ts";

Deno.test("present drops only null and undefined fields", () => {
  assertEquals(present({ a: 1, b: null, c: undefined, d: "", e: 0, f: false }), { a: 1, d: "", e: 0, f: false });
});

Deno.test("decodeEntities unwraps CDATA and decodes named and numeric entities", () => {
  assertEquals(decodeEntities(" <![CDATA[Foo &amp; Bar]]> &#x27;s&nbsp;&#8217; "), "Foo & Bar 's ’");
  assertEquals(decodeEntities("&lt;b&gt; &quot;x&quot; &amp;amp;"), '<b> "x" &amp;');
});

Deno.test("extractTag reads the first tag, with or without attributes", () => {
  assertEquals(extractTag('<item><title type="html">A &amp; B</title><title>C</title></item>', "title"), "A & B");
  assertEquals(extractTag("<entry><yt:videoId>abc</yt:videoId></entry>", "yt:videoId"), "abc");
  assertEquals(extractTag("<entry></entry>", "title"), null);
});

Deno.test("httpUrl keeps http(s) urls, resolved against a base", () => {
  assertEquals(httpUrl("/a.png", "https://x.com/post"), "https://x.com/a.png");
  assertEquals(httpUrl("javascript:alert(1)"), null);
  assertEquals(httpUrl(null), null);
});

Deno.test("pastDate drops future and unparseable dates", () => {
  assertEquals(pastDate("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z");
  assertEquals(pastDate("3024-01-01T00:00:00Z"), null);
  assertEquals(pastDate("not a date"), null);
});

Deno.test("mapSeries runs one at a time, in order", async () => {
  const started: number[] = [];
  let running = 0;
  const out = await mapSeries([3, 1, 2], async (n, i) => {
    started.push(n);
    running++;
    assertEquals(running, 1);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10 + i;
  });
  assertEquals(started, [3, 1, 2]);
  assertEquals(out, [30, 11, 22]);
});
