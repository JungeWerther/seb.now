// The built page in headless Chromium, with supabase-js swapped for a fake:
// the pinned script's URL, SRI hash and CSP are pointed at a stand-in that
// answers each table from `answers` (filtered by .eq and .in) and records
// every write and rpc in window.__calls. `delays` holds how long, in ms, a
// "<table>.<method>" query takes to answer (`{ "entities.in": 1500 }`). Needs uv (to build the page) and a
// Chromium (CHROMIUM_PATH, else Playwright's own).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const USER_ID = "00000000-0000-0000-0000-000000000001";

const fakeSupabase = (answers, delays) => `(() => {
  window.__calls = [];
  const answers = ${JSON.stringify(answers)};
  const delays = ${JSON.stringify(delays)};
  const WRITES = ["insert", "upsert", "update", "delete"];
  const chain = (table, rows, delay = 0) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve) => setTimeout(() => resolve({ data: rows, error: null, count: 0 }), delay);
      return (...args) => {
        if (WRITES.includes(prop)) window.__calls.push({ table, op: prop, args });
        const wait = Math.max(delay, delays[table + "." + prop] ?? 0);
        if (prop === "eq") return chain(table, rows.filter((row) => !(args[0] in row) || row[args[0]] === args[1]), wait);
        if (prop === "in") return chain(table, rows.filter((row) => !(args[0] in row) || args[1].includes(row[args[0]])), wait);
        if (prop === "single" || prop === "maybeSingle") return chain(table, rows[0] ?? null, wait);
        return chain(table, rows, wait);
      };
    },
  });
  const user = { id: "${USER_ID}" };
  const session = { user, access_token: "t" };
  window.supabase = { createClient: () => ({
    from: (table) => chain(table, answers[table] ?? []),
    rpc: (fn, args) => {
      window.__calls.push({ table: fn, op: "rpc", args: [args] });
      return chain(fn, answers[fn] ?? []);
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

// Serves the page built with `answers` on `port`; returns { browser, origin, close }.
export async function servePage(answers, port, delays = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "qa-page-"));
  const fake = fakeSupabase(answers, delays);
  writeFileSync(join(dir, "fake-supabase.js"), fake);
  const integrity = `sha384-${createHash("sha384").update(fake).digest("base64")}`;
  execFileSync("uv", ["run", "--quiet", "python", "-c", `
import seb_now.site as site, seb_now.sanitize as sanitize
site.SUPABASE_JS_URL = sanitize.SUPABASE_JS_URL = "${origin}/fake-supabase.js"
site.SUPABASE_JS_INTEGRITY = "${integrity}"
open("${join(dir, "index.html")}", "w").write(site.render([], supabase_url="${origin}", supabase_anon_key="x"))
`], { cwd: new URL("../..", import.meta.url), stdio: "inherit" });
  const server = createServer((req, res) => {
    const file = req.url.endsWith(".js") ? "fake-supabase.js" : "index.html";
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(join(dir, file)));
  }).listen(port);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  return { browser, origin, close: async () => { await browser.close(); server.close(); } };
}

// A new tab on the page, once the feed has rendered; its script errors land in `errors`.
export async function openPage(browser, origin, context) {
  const page = await (context ?? browser).newPage({ viewport: { width: 800, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => document.querySelectorAll("ul.articles li.article").length > 0);
  return { page, errors };
}

export function checker() {
  let failures = 0;
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
  };
  return { check, failed: () => failures > 0 };
}
