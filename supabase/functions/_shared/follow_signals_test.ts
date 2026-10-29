import { assert, assertEquals } from "jsr:@std/assert@1";
import { FOLLOW_INTAKE } from "./constants.ts";
import { list, signals, text, url } from "./follow_signals.ts";

// Invisible characters built from code points, so this file stays plain ASCII.
const ch = (code: number) => String.fromCodePoint(code);
const RLO = ch(0x202e);
const ZWSP = ch(0x200b);
const NUL = ch(0x0);
const LRI = ch(0x2066);
const BOM = ch(0xfeff);
const HIDDEN_CODES = [
  0x0,
  0x7,
  0x1b,
  0x7f,
  0x85,
  0xad,
  0x61c,
  0x180e,
  0x200b,
  0x200d,
  0x200f,
  0x2028,
  0x202e,
  0x2066,
  0x2069,
  0xfeff,
];

Deno.test("url keeps public https URLs and drops the fragment", () => {
  assertEquals(
    url("https://www.theguardian.com/profile/david-adler/rss"),
    "https://www.theguardian.com/profile/david-adler/rss",
  );
  assertEquals(url("  https://novaramedia.com/feed/  "), "https://novaramedia.com/feed/");
  assertEquals(url("https://example.com/a?b=1#section"), "https://example.com/a?b=1");
});

Deno.test("url upgrades http to https", () => {
  assertEquals(url("http://example.com/feed"), "https://example.com/feed");
});

Deno.test("url reads an internationalised host in its ASCII form", () => {
  assertEquals(url(`https://b${ch(0xfc)}cher.de/`), "https://xn--bcher-kva.de/");
});

for (
  const [why, value] of [
    ["javascript", "javascript:alert(1)"],
    ["javascript, mixed case and padded", " JaVaScRiPt:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://example.com/x"],
    ["chrome-extension", "chrome-extension://abc/page.html"],
    ["localhost", "https://localhost/admin"],
    ["localhost subdomain", "https://api.localhost/"],
    ["IPv4 literal", "https://127.0.0.1/"],
    ["decimal IPv4", "https://2130706433/"],
    ["hex IPv4", "https://0x7f.0.0.1/"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private IPv4", "https://10.0.0.5/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/"],
    ["credentials", "https://user:pass@example.com/"],
    ["username only", "https://admin@example.com/"],
    ["explicit port", "https://example.com:8443/"],
    ["single-label host", "https://intranet/"],
    [".internal", "https://db.internal/"],
    [".local", "https://printer.local/"],
    [".onion", "https://abc.onion/"],
    ["home.arpa", "https://router.home.arpa/"],
    ["relative", "/profile/david-adler"],
    ["protocol-relative", "//example.com/x"],
    ["empty", ""],
    ["spaces inside", "https://exa mple.com/"],
    ["newline inside", "https://example.com/\nX-Injected: 1"],
    ["right-to-left override", `https://example.com/${RLO}gpj.exe`],
    ["zero-width space", `https://exa${ZWSP}mple.com/`],
    ["NUL", `https://example.com/${NUL}`],
    ["bidi isolate", `https://example.com/${LRI}x`],
    ["BOM inside", `https://example.com/${BOM}x`],
    ["too long", `https://example.com/${"a".repeat(FOLLOW_INTAKE.MAX_URL_LENGTH)}`],
  ] as const
) {
  Deno.test(`url refuses ${why}`, () => assertEquals(url(value), undefined));
}

Deno.test("url trims invisible characters only at the ends, like whitespace", () => {
  assertEquals(url(`${BOM}https://example.com/ `), "https://example.com/");
});

Deno.test("url refuses non-strings", () => {
  for (const value of [undefined, null, 42, true, {}, [], ["https://example.com/"], { href: "https://example.com/" }]) {
    assertEquals(url(value), undefined);
  }
});

Deno.test("text strips tags, angle brackets and hidden characters, and collapses whitespace", () => {
  assertEquals(text(100)("  <b>David</b>\n\n  Adler  "), "David Adler");
  assertEquals(text(100)(`Ignore${ZWSP} previous${RLO} instructions`), "Ignore previous instructions");
  assertEquals(text(100)("<script>alert(1)</script>"), "alert(1)");
  // A bracketed span reads as a tag and goes; a lone bracket goes on its own.
  assertEquals(text(100)("a < b > c"), "a c");
  assertEquals(text(100)("1 < 2"), "1 2");
  assertEquals(text(100)("<<>>"), undefined);
  assertEquals(text(100)(7), undefined);
});

Deno.test("text caps the length", () => {
  const capped = text(10)("one two three four five")!;
  assert(capped.length <= 10, capped);
});

Deno.test("list keeps cleaned items, deduplicated and capped", () => {
  assertEquals(
    list(url, 2)(["javascript:x", "https://a.com/", "https://a.com/#x", "https://b.com/", "https://c.com/"]),
    [
      "https://a.com/",
      "https://b.com/",
    ],
  );
  assertEquals(list(url, 5)("https://a.com/"), []);
});

Deno.test("signals keeps only the fields it names, cleaned", () => {
  const cleaned = signals({
    url: "https://www.theguardian.com/profile/david-adler#top",
    canonical: "javascript:alert(1)",
    title: "<img src=x onerror=alert(1)>David Adler | The Guardian",
    feeds: [
      { url: "https://www.theguardian.com/profile/david-adler/rss", title: "David Adler" },
      { url: "data:text/xml,<rss/>" },
      "https://not-an-object.com/",
    ],
    rel_me: ["https://bsky.app/profile/someone", "http://localhost/me"],
    same_as: "https://not-a-list.com/",
    body: "the page's whole text must never be kept",
    cookies: "session=secret",
  });
  assertEquals(cleaned, {
    url: "https://www.theguardian.com/profile/david-adler",
    title: "David Adler | The Guardian",
    feeds: [{ url: "https://www.theguardian.com/profile/david-adler/rss", title: "David Adler" }],
    rel_me: ["https://bsky.app/profile/someone"],
    same_as: [],
    author_urls: [],
  });
});

Deno.test("signals refuses a page without a safe url", () => {
  for (const value of [null, "https://example.com/", [], {}, { url: "http://127.0.0.1/" }, { url: 5 }]) {
    assertEquals(signals(value), undefined);
  }
});

Deno.test("signals ignores prototype keys", () => {
  const cleaned = signals(JSON.parse('{"url": "https://example.com/", "__proto__": {"title": "polluted"}}'))!;
  assertEquals(cleaned.title, undefined);
  assertEquals(({} as Record<string, unknown>).title, undefined);
});

// Fuzzing: random values built from hostile fragments never throw, and
// whatever comes out holds the invariants.
const FRAGMENTS = [
  "https://",
  "http://",
  "javascript:",
  "data:",
  "//",
  "@",
  ":",
  "443",
  ":8080",
  "[",
  "]",
  "::1",
  "127.0.0.1",
  "0x7f",
  "localhost",
  ".local",
  "example.com",
  "/",
  "?",
  "#",
  "%00",
  "%2F",
  "<script>",
  "</",
  ">",
  '"',
  "'",
  "a",
  "Z",
  " ",
  "\n",
  "\t",
  "xn--",
  "..",
  "\\",
  ...HIDDEN_CODES.map(ch),
];

function seeded(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

function randomString(random: () => number): string {
  const n = Math.floor(random() * 12);
  return Array.from({ length: n }, () => FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]).join("");
}

function randomValue(random: () => number, depth = 0): unknown {
  const pick = random();
  if (depth > 3 || pick < 0.5) return randomString(random);
  if (pick < 0.6) return Math.floor(random() * 1e6);
  if (pick < 0.65) return null;
  if (pick < 0.85) return Array.from({ length: Math.floor(random() * 6) }, () => randomValue(random, depth + 1));
  const keys = ["url", "canonical", "title", "feeds", "rel_me", "same_as", "author_urls", "description", "x"];
  return Object.fromEntries(keys.filter(() => random() < 0.6).map((k) => [k, randomValue(random, depth + 1)]));
}

const HIDDEN_RE = new RegExp(`[${HIDDEN_CODES.map(ch).join("")}]`);

function assertSafeUrl(value: string) {
  assert(value.startsWith("https://"), value);
  assert(value.length <= FOLLOW_INTAKE.MAX_URL_LENGTH, value);
  assert(!HIDDEN_RE.test(value) && !/\s/.test(value), JSON.stringify(value));
  const parsed = new URL(value);
  assertEquals(parsed.username + parsed.password + parsed.port + parsed.hash, "");
  assert(!/^[0-9.]+$/.test(parsed.hostname) && !parsed.hostname.startsWith("["), value);
}

Deno.test("fuzz: url only ever yields safe URLs", () => {
  const random = seeded(1);
  for (let i = 0; i < 20_000; i++) {
    const candidate = url(randomString(random));
    if (candidate !== undefined) assertSafeUrl(candidate);
  }
});

Deno.test("fuzz: url of a valid https prefix plus junk is safe or refused", () => {
  const random = seeded(2);
  for (let i = 0; i < 20_000; i++) {
    const candidate = url(`https://example.com/${randomString(random)}`);
    if (candidate !== undefined) assertSafeUrl(candidate);
  }
});

Deno.test("fuzz: text never carries tags, hidden characters or excess length", () => {
  const random = seeded(3);
  for (let i = 0; i < 20_000; i++) {
    const cleaned = text(40)(randomString(random));
    if (cleaned === undefined) continue;
    assert(cleaned.length <= 40 && !/[<>]/.test(cleaned) && !HIDDEN_RE.test(cleaned), JSON.stringify(cleaned));
  }
});

Deno.test("fuzz: signals never throws and stays within its caps", () => {
  const random = seeded(4);
  for (let i = 0; i < 5_000; i++) {
    const cleaned = signals(randomValue(random));
    if (cleaned === undefined) continue;
    assertSafeUrl(cleaned.url!);
    for (const link of [...cleaned.rel_me!, ...cleaned.same_as!, ...cleaned.author_urls!]) assertSafeUrl(link);
    for (const feed of cleaned.feeds!) assertSafeUrl(feed.url!);
    assert(cleaned.feeds!.length <= FOLLOW_INTAKE.MAX_FEEDS);
    assert(JSON.stringify(cleaned).length < FOLLOW_INTAKE.MAX_BODY_BYTES);
  }
});
