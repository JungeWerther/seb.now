// The built extension in Chromium against the real seb.now/connect page: the
// popup connects to an account (pairing code, approval), reads a real page,
// sends its signals to the intake and opens Claude with /follow. Run with
// `npm run e2e` (the --e2e build grants host access, standing in for the
// toolbar click that grants activeTab). seb.now/connect is the page site.py
// builds, served with a fake supabase-js; the intake and claude.ai are
// intercepted, never reached.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CONFIG } from "../../src/config.ts";

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const fixtures = new URL("../fixtures/", import.meta.url);
const TOKEN = `sft_${"ab".repeat(32)}`;
const CODE = "K7Q-2MX";

// supabase-js as the connect page uses it: a session, and the three RPCs,
// answered from window.fakeSeb so the test can approve the account.
const FAKE_SUPABASE = `
window.fakeSeb = { approved: false, revoked: [], requested: [] };
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: { user: { is_anonymous: true } } } }),
    signInAnonymously: async () => ({ data: { session: { user: { is_anonymous: true } } }, error: null }),
  },
  rpc: async (name, args) => {
    const seb = window.fakeSeb;
    if (name === "request_follow_token") {
      seb.requested.push(args.label);
      return { data: [{ token_id: "t1", token: "${TOKEN}", status: "pending", pair_code: "${CODE}" }], error: null };
    }
    if (name === "my_follow_tokens") {
      return { data: [{ token_id: "t1", label: "Chrome", status: seb.approved ? "active" : "pending", pair_code: seb.approved ? null : "${CODE}" }], error: null };
    }
    if (name === "revoke_follow_token") { seb.revoked.push(args.token_id); return { data: true, error: null }; }
    return { data: null, error: { message: "unexpected rpc " + name } };
  },
}) };`;

// The connect page site.py builds, with supabase-js's integrity set to the fake's.
function renderConnect() {
  const integrity = `sha384-${createHash("sha384").update(FAKE_SUPABASE).digest("base64")}`;
  const script = [
    "import seb_now.connect as c",
    `c.SUPABASE_JS_INTEGRITY = ${JSON.stringify(integrity)}`,
    "print(c.render_connect(supabase_url='https://fake.supabase.co', supabase_anon_key='k'), end='')",
  ].join("\n");
  return execFileSync("uv", ["run", "--quiet", "python", "-c", script], { cwd: repo, encoding: "utf8" });
}

// Chromium names an unpacked extension after its path: the SHA-256 of it,
// first 32 hex digits, each mapped 0-f to a-p.
const extensionId = createHash("sha256").update(dist).digest("hex").slice(0, 32)
  .replace(/[0-9a-f]/g, (d) => String.fromCharCode(97 + parseInt(d, 16)));

let server, origin, context, profile, connectPage, supabaseJsUrl;
const intake = [];

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const body = await readFile(new URL(req.url.slice(1), fixtures));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const html = renderConnect();
  supabaseJsUrl = html.match(/script\.src = "([^"]+)"/)[1];
  profile = await mkdtemp(join(tmpdir(), "follow-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  await context.route(`${CONFIG.SEB_NOW_ORIGIN}${CONFIG.CONNECT_PATH}*`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await context.route(supabaseJsUrl, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: FAKE_SUPABASE }));
  await context.route(`${CONFIG.INTAKE_URL}*`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    intake.push({ auth: req.headers().authorization, body: req.postDataJSON() });
    const approved = await connectPage.evaluate(() => window.fakeSeb.approved);
    return approved
      ? route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: '{"status":"pending"}' })
      : route.fulfill({ status: 403, contentType: "application/json", headers: cors, body: JSON.stringify({ error: "waiting for approval", pair_code: CODE }) });
  });
  await context.route("https://claude.ai/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Claude</title>" }));
});

after(async () => {
  await context?.close();
  server?.close();
  await rm(profile, { recursive: true, force: true });
});

const extensionPage = async (name) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${name}`);
  return page;
};

const statusOf = (page, selector, state) =>
  page.waitForFunction(([s, st]) => document.querySelector(s)?.dataset.state === st, [selector, state]);

test("a forged nonce: the extension takes nothing, and the page revokes the token it made", async () => {
  const page = await context.newPage();
  await page.goto(`${CONFIG.SEB_NOW_ORIGIN}${CONFIG.CONNECT_PATH}#nonce=${"f".repeat(32)}`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("didn't answer"), null, { timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => window.fakeSeb.revoked), ["t1"]);
  // The nonce left the address bar.
  assert.equal(new URL(page.url()).hash, "");
  const options = await extensionPage("options.html");
  await options.waitForFunction(() => document.querySelector("#state")?.textContent === "Not connected.");
  await options.close();
  await page.close();
});

test("Follow without a connection opens seb.now/connect, which hands over a pending token", async () => {
  const popup = await extensionPage("popup.html");
  assert.equal(await popup.textContent("#follow"), "Connect seb.now");
  const opening = context.waitForEvent("page", (page) => page.url().startsWith(`${CONFIG.SEB_NOW_ORIGIN}${CONFIG.CONNECT_PATH}`));
  await popup.click("#follow");
  connectPage = await opening;
  // A tab the extension opens starts loading before Playwright's routing
  // reaches it, so load it again, nonce and all, through the route.
  const opened = connectPage.url();
  assert.match(opened, /#nonce=[A-Za-z0-9_-]{32}$/);
  await connectPage.goto("about:blank");
  await connectPage.goto(opened);
  await connectPage.waitForFunction(() => document.querySelector("#pair-code")?.textContent === "K7Q-2MX", null, { timeout: 15_000 });
  assert.equal(await connectPage.textContent("#status"), "Connected, waiting for approval.");
  assert.deepEqual(await connectPage.evaluate(() => window.fakeSeb.revoked), []);

  const options = await extensionPage("options.html");
  await options.waitForFunction((code) => document.querySelector("#state")?.textContent.includes(code), CODE);
  await options.close();
});

test("while pending, Follow sends the token and shows the pairing code", async () => {
  const article = await context.newPage();
  await article.goto(`${origin}/guardian-profile.html`);
  const popup = await extensionPage("popup.html");
  await popup.waitForFunction(() => document.querySelector("#follow")?.textContent === "Follow");
  const sent = intake.length;
  await popup.click("#follow");
  await statusOf(popup, "#status", "error");
  assert.equal(await popup.textContent("#status"), `Waiting for approval, code ${CODE}.`);
  assert.equal(intake[sent].auth, `Bearer ${TOKEN}`);
  await popup.close();
  await article.close();
});

test("once approved, the connect page says so and Follow sends the page and opens Claude", async () => {
  await connectPage.evaluate(() => { window.fakeSeb.approved = true; });
  await connectPage.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("Approved."), null, { timeout: 15_000 });

  const article = await context.newPage();
  await article.goto(`${origin}/guardian-profile.html`);
  const popup = await extensionPage("popup.html");
  await popup.waitForFunction(() => document.querySelector("#page")?.textContent !== "");
  const claude = context.waitForEvent("page", (page) => page.url().startsWith("https://claude.ai/"));
  const sent = intake.length;
  await popup.click("#follow");
  const opened = await claude;

  const { auth, body } = intake[sent];
  assert.equal(auth, `Bearer ${TOKEN}`);
  assert.equal(body.url, `${origin}/guardian-profile.html`);
  assert.deepEqual(body.feeds, [{ url: `${origin}/profile/david-adler/rss`, title: "David Adler | The Guardian" }]);
  assert.ok(!JSON.stringify(body).includes("Private reader text"));
  assert.equal(new URL(opened.url()).searchParams.get("q"), `/follow ${origin}/guardian-profile.html`);

  const options = await extensionPage("options.html");
  await options.waitForFunction(() => document.querySelector("#state")?.textContent === "Connected.");
  await options.close();
  await opened.close();
  await article.close();
});

test("opened without a nonce, seb.now/connect lists this account's devices", async () => {
  const page = await context.newPage();
  await page.goto(`${CONFIG.SEB_NOW_ORIGIN}${CONFIG.CONNECT_PATH}`);
  await page.waitForSelector("#devices li");
  assert.equal(await page.textContent("#devices .label"), "Chrome");
  await page.click("#devices button");
  await page.waitForFunction(() => document.querySelectorAll("#devices li").length === 0);
  assert.deepEqual(await page.evaluate(() => window.fakeSeb.revoked), ["t1"]);
  await page.close();
});
