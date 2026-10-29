import { assert, assertEquals } from "jsr:@std/assert@1";
import { FOLLOW_INTAKE } from "./constants.ts";
import { followIntake, type IntakeDeps } from "./follow_intake.ts";
import type { Signals } from "./follow_signals.ts";

const TOKEN = "s3cret-token-for-tests";
const ENDPOINT = "https://example.supabase.co/functions/v1/follow-intake";

function intake(overrides: Partial<IntakeDeps> = {}) {
  const staged: { pageUrl: string; signals: Signals }[] = [];
  const handler = followIntake({
    token: () => Promise.resolve(TOKEN),
    stage: (pageUrl, signals) => {
      staged.push({ pageUrl, signals });
      return Promise.resolve("00000000-0000-4000-8000-000000000001");
    },
    recent: () => Promise.resolve(0),
    ...overrides,
  });
  return { handler, staged };
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(ENDPOINT, {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
  });

const page = {
  url: "https://www.theguardian.com/profile/david-adler",
  title: "David Adler | The Guardian",
  feeds: [{ url: "https://www.theguardian.com/profile/david-adler/rss" }, { url: "javascript:alert(1)" }],
  same_as: ["https://bsky.app/profile/example", "https://169.254.169.254/"],
  body: "never stored",
};

Deno.test("a preflight is answered with CORS and no auth", async () => {
  const res = await intake().handler(new Request(ENDPOINT, { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(res.headers.get("access-control-allow-headers")!.includes("authorization"));
});

Deno.test("only POST is accepted, and refusals still carry CORS", async () => {
  const res = await intake().handler(new Request(ENDPOINT, { method: "GET" }));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("a missing, malformed or wrong token is 401 and stages nothing", async () => {
  for (
    const authorization of [
      undefined,
      "",
      "Bearer",
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      "Bearer wrong",
    ]
  ) {
    const { handler, staged } = intake();
    const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
    const req = new Request(ENDPOINT, { method: "POST", body: JSON.stringify(page), headers });
    assertEquals((await handler(req)).status, 401, String(authorization));
    assertEquals(staged.length, 0);
  }
});

Deno.test("a body over the cap is 413, by header or by what arrives", async () => {
  const big = JSON.stringify({ ...page, title: "x".repeat(FOLLOW_INTAKE.MAX_BODY_BYTES) });
  assertEquals((await intake().handler(post(big))).status, 413);
  const lying = post(big, { "content-length": "10" });
  assertEquals((await intake().handler(lying)).status, 413);
});

Deno.test("a body that isn't JSON or UTF-8 is 400", async () => {
  assertEquals((await intake().handler(post("{not json"))).status, 400);
  assertEquals((await intake().handler(post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])))).status, 400);
  assertEquals((await intake().handler(post(null))).status, 400);
});

Deno.test("a page without a public https url is 422", async () => {
  for (const url of ["javascript:alert(1)", "https://localhost/", "https://[::1]/", undefined]) {
    const { handler, staged } = intake();
    assertEquals((await handler(post(JSON.stringify({ ...page, url })))).status, 422, String(url));
    assertEquals(staged.length, 0);
  }
});

Deno.test("too many recent pages is 429, checked before the body is read", async () => {
  const { handler, staged } = intake({ recent: () => Promise.resolve(FOLLOW_INTAKE.MAX_PER_WINDOW) });
  assertEquals((await handler(post(JSON.stringify(page)))).status, 429);
  assertEquals(staged.length, 0);
});

Deno.test("a valid page is staged with its signals cleaned", async () => {
  const { handler, staged } = intake();
  const res = await handler(post(JSON.stringify(page)));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    id: "00000000-0000-4000-8000-000000000001",
    page_url: page.url,
    status: "pending",
  });
  assertEquals(staged, [{
    pageUrl: page.url,
    signals: {
      url: page.url,
      title: page.title,
      feeds: [{ url: "https://www.theguardian.com/profile/david-adler/rss" }],
      rel_me: [],
      same_as: ["https://bsky.app/profile/example"],
      author_urls: [],
    },
  }]);
});

Deno.test("the page's own canonical never replaces the page it was sent from", async () => {
  const { handler, staged } = intake();
  await handler(post(JSON.stringify({ ...page, canonical: "https://elsewhere.example.org/" })));
  assertEquals(staged[0].pageUrl, page.url);
  assertEquals(staged[0].signals.canonical, "https://elsewhere.example.org/");
});

Deno.test("a store failure is 500 without its detail", async () => {
  const { handler } = intake({
    stage: () => Promise.reject(new Error("duplicate key value violates follow_inbox_pkey")),
  });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await handler(post(JSON.stringify(page)));
    assertEquals(res.status, 500);
    assert(!(await res.text()).includes("follow_inbox"));
  } finally {
    console.error = original;
  }
});
