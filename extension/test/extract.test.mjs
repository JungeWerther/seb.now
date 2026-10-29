import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { CONFIG } from "../src/config.ts";
import { extractSignals } from "../src/extract.ts";

const fixture = async (name) => (await readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const read = async (name, href) => extractSignals(CONFIG.LIMITS, parseHTML(await fixture(name)).document, href);

test("a Guardian profile: its feed, resolved against the page, and its names", async () => {
  const signals = await read("guardian-profile.html", "https://www.theguardian.com/profile/david-adler");
  assert.deepEqual(signals, {
    url: "https://www.theguardian.com/profile/david-adler",
    canonical: "https://www.theguardian.com/profile/david-adler",
    title: "David Adler | The Guardian",
    site_name: "the Guardian",
    description: "Latest articles by David Adler.",
    feeds: [{ url: "https://www.theguardian.com/profile/david-adler/rss", title: "David Adler | The Guardian" }],
    rel_me: [],
    same_as: [],
    author_urls: [],
  });
});

test("never sends the page's text", async () => {
  const signals = await read("guardian-profile.html", "https://www.theguardian.com/profile/david-adler");
  assert.ok(!JSON.stringify(signals).includes("Private reader text"));
});

test("a post: rel=me, JSON-LD author pages and sameAs of people and organisations", async () => {
  const signals = await read("substack-post.html", "https://letters.example.org/p/why-we-sailed");
  assert.equal(signals.author, "Ada Example");
  assert.deepEqual(signals.feeds, [{ url: "https://letters.example.org/feed", title: "Example Letters" }]);
  assert.deepEqual(signals.rel_me, ["https://mastodon.example.net/@ada"]);
  assert.deepEqual(signals.same_as, [
    "https://bsky.app/profile/ada.example.org",
    "https://www.youtube.com/@adaexample",
    "https://letters.example.org/",
  ]);
  assert.deepEqual(signals.author_urls, ["https://letters.example.org/about", "https://letters.example.org/@ada"]);
});

test("a profile page whose person sits in @graph under mainEntity, sameAs deduplicated", async () => {
  const signals = await read("profile-graph.html", "https://social.example.org/profile/ada.example.org");
  assert.deepEqual(signals.same_as, ["https://ada.example.org/"]);
  assert.deepEqual(signals.feeds, [{ url: "https://social.example.org/profile/rss" }]);
});

test("a challenge page yields only its address and title", async () => {
  const signals = await read("challenge.html", "https://blocked.example.com/");
  assert.deepEqual(signals, {
    url: "https://blocked.example.com/",
    title: "Just a moment...",
    feeds: [],
    rel_me: [],
    same_as: [],
    author_urls: [],
  });
});

test("a hostile page: everything capped, nothing thrown", async () => {
  const signals = await read("hostile.html", "https://hostile.example.com/page");
  // Lists capped, strings capped.
  assert.equal(signals.feeds.length, CONFIG.LIMITS.maxItems);
  assert.equal(signals.title.length, CONFIG.LIMITS.maxString);
  // Only feed types count, whatever their case and spacing; relative links
  // resolve against <base>.
  assert.ok(!signals.feeds.some((f) => f.url.endsWith("not-a-feed.html")));
  assert.deepEqual(signals.feeds[0], { url: "https://cdn.example.net/assets/feed.xml", title: "spaced" });
  // Candidates are sent as found: the intake refuses javascript: and data:,
  // so here they only need to be strings.
  assert.ok(signals.rel_me.includes("https://good.example.com/me"));
  assert.ok(signals.rel_me.includes("https://cdn.example.net/assets/relative/me"));
  // Broken JSON-LD is skipped; deep JSON-LD is walked to a bounded depth.
  assert.ok(signals.same_as.length <= 8, String(signals.same_as.length));
  assert.ok(JSON.stringify(signals).length < 200_000);
});

test("an oversized JSON-LD script is skipped, not parsed", () => {
  const huge = `{"@type": "Person", "sameAs": "https://${"x".repeat(CONFIG.LIMITS.maxJsonLdChars)}.example.com"}`;
  const { document } = parseHTML(`<html><head><script type="application/ld+json">${huge}</script></head></html>`);
  assert.deepEqual(extractSignals(CONFIG.LIMITS, document, "https://example.com/").same_as, []);
});

test("an unparseable page address is still sent, as the intake decides", () => {
  const { document } = parseHTML("<html><head><link rel='alternate' type='application/rss+xml' href='feed'></head></html>");
  const signals = extractSignals(CONFIG.LIMITS, document, "not a url");
  assert.equal(signals.url, "not a url");
  assert.deepEqual(signals.feeds, []);
});

// executeScript sends the function's source alone: take it from the same
// esbuild bundle the popup ships and run it with nothing but the page's
// globals, as the browser will.
test("extractSignals is self-contained", async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/extract.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2022",
  });
  const bundled = await import(`data:text/javascript,${encodeURIComponent(outputFiles[0].text)}`);
  const { document } = parseHTML(await fixture("guardian-profile.html"));
  const page = { document, location: { href: "https://www.theguardian.com/profile/david-adler" }, URL };
  const injected = vm.runInNewContext(`(${bundled.extractSignals.toString()})`, page);
  const signals = injected(JSON.parse(JSON.stringify(CONFIG.LIMITS)));
  assert.equal(signals.feeds[0].url, "https://www.theguardian.com/profile/david-adler/rss");
});
