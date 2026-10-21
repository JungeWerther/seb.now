// Runs the built page in headless Chromium, with supabase-js swapped for a fake
// that answers one link and records every write, to check when a row counts as
// seen: only after SEEN_DWELL_MS on screen while the page is visible, with
// seen_at the moment its dwell ended. Needs uv (to build the page) and a
// Chromium (CHROMIUM_PATH, else Playwright's own).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LINK_ID = "11111111-1111-1111-1111-111111111111";

const FAKE_SUPABASE = `(() => {
  window.__calls = [];
  const link = { id: "${LINK_ID}", url: "https://example.com/a", title: "A seen-links test row",
    created_at: new Date().toISOString(), author: null, image_url: null, description: null,
    link_topics: [], link_entities: [], seq: 1 };
  const answers = { ranked_feed: [{ link_id: link.id, rank: 1 }], feed_query: [{ link_id: link.id, rank: 1 }], links: [link] };
  const chain = (table) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve) => resolve({ data: answers[table] ?? [], error: null, count: 0 });
      return (...args) => {
        if (["insert", "upsert", "update", "delete"].includes(prop)) window.__calls.push({ table, op: prop, args });
        return chain(table);
      };
    },
  });
  const user = { id: "00000000-0000-0000-0000-000000000001" };
  const session = { user, access_token: "t" };
  window.supabase = { createClient: () => ({
    from: chain,
    rpc: (fn, args) => {
      window.__calls.push({ table: fn, op: "rpc", args: [args] });
      return chain(fn);
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInAnonymously: async () => ({ data: { session, user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getUser: async () => ({ data: { user }, error: null }),
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  }) };
})();`;

// The page as site.py builds it, its pinned supabase-js (URL, SRI hash and CSP)
// pointed at the fake.
const dir = mkdtempSync(join(tmpdir(), "seen-page-"));
writeFileSync(join(dir, "fake-supabase.js"), FAKE_SUPABASE);
const integrity = `sha384-${createHash("sha384").update(FAKE_SUPABASE).digest("base64")}`;
execFileSync("uv", ["run", "--quiet", "python", "-c", `
import seb_now.site as site, seb_now.sanitize as sanitize
site.SUPABASE_JS_URL = sanitize.SUPABASE_JS_URL = "${ORIGIN}/fake-supabase.js"
site.SUPABASE_JS_INTEGRITY = "${integrity}"
open("${join(dir, "index.html")}", "w").write(site.render([], supabase_url="${ORIGIN}", supabase_anon_key="x"))
`], { cwd: new URL("../..", import.meta.url), stdio: "inherit" });

const server = createServer((req, res) => {
  const file = req.url.endsWith(".js") ? "fake-supabase.js" : "index.html";
  res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(readFileSync(join(dir, file)));
}).listen(PORT);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

const setVisibility = (page, state) => page.evaluate((s) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);
const seenWrites = (page) => page.evaluate(() => window.__calls.filter((c) => c.table === "link_impressions"));

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => document.querySelectorAll("ul.articles li.article").length > 0);
  return { page, errors };
}

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

{
  const { page, errors } = await openPage();
  await page.waitForTimeout(1500);
  const hiddenAt = Date.now();
  await setVisibility(page, "hidden");
  await page.waitForTimeout(300);
  const writes = await seenWrites(page);
  check("a row on screen for a full second is recorded once", writes.length, 1);
  check("as this reader and link", [writes[0]?.args[0][0].viewer_id, writes[0]?.args[0][0].link_id],
    ["00000000-0000-0000-0000-000000000001", LINK_ID]);
  check("with seen_at when its dwell ended, not when it was flushed",
    Date.parse(writes[0]?.args[0][0].seen_at) < hiddenAt - 200, true);
  check("no script errors", errors, []);
  await page.close();
}

{
  const { page, errors } = await openPage();
  await page.waitForTimeout(300);
  await setVisibility(page, "hidden");
  await page.waitForTimeout(1500);
  check("hidden mid-dwell: not recorded", (await seenWrites(page)).length, 0);
  await setVisibility(page, "visible");
  await page.waitForTimeout(500);
  await setVisibility(page, "hidden");
  check("back for half a second: still not, its dwell starts over", (await seenWrites(page)).length, 0);
  await setVisibility(page, "visible");
  await page.waitForTimeout(1300);
  await setVisibility(page, "hidden");
  await page.waitForTimeout(300);
  check("back for a full second: recorded", (await seenWrites(page)).length, 1);
  check("no script errors", errors, []);
  await page.close();
}

{
  // A row's dwell ends, and the reader starts a new feed before the next flush:
  // its impression is written before that feed's first page is asked for, so
  // it can't land between pages and reorder them.
  const { page, errors } = await openPage();
  await page.waitForTimeout(1300);
  check("dwell done, flush still pending", (await seenWrites(page)).length, 0);
  const before = await page.evaluate(() => window.__calls.length);
  await page.fill("#search-input", "latest");
  await page.press("#search-input", "Enter");
  await page.waitForTimeout(800);
  const after = await page.evaluate((n) => window.__calls.slice(n).map((c) => `${c.op} ${c.table}`), before);
  const write = after.indexOf("upsert link_impressions");
  const firstPage = after.findIndex((c) => c === "rpc feed_query" || c === "rpc ranked_feed");
  check("the impression is written", write >= 0, true);
  check("before the new feed's first page", write >= 0 && firstPage > write, true);
  check("no script errors", errors, []);
  await page.close();
}

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
