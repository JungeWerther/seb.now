// The built extension in Chromium: the popup reads a real page, sends its
// signals to the intake and opens Claude with /follow. Run with `npm run e2e`
// (the --e2e build grants host access, standing in for the toolbar click that
// grants activeTab). The intake and claude.ai are intercepted, never reached.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CONFIG } from "../../src/config.ts";

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
const fixtures = new URL("../fixtures/", import.meta.url);

// Chromium names an unpacked extension after its path: the SHA-256 of it,
// first 32 hex digits, each mapped 0-f to a-p.
const extensionId = createHash("sha256").update(dist).digest("hex").slice(0, 32)
  .replace(/[0-9a-f]/g, (d) => String.fromCharCode(97 + parseInt(d, 16)));

let server, origin, context, profile;
const intake = [];
let intakeStatus = 200;

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
  profile = await mkdtemp(join(tmpdir(), "follow-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  await context.route(`${CONFIG.INTAKE_URL}*`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" } });
    intake.push({ auth: req.headers().authorization, body: req.postDataJSON() });
    const status = req.postData() === "{}" ? 422 : intakeStatus;
    return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" });
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

test("options: a token the intake accepts is saved", async () => {
  const options = await extensionPage("options.html");
  await options.fill("#token", "e2e-token");
  await options.click("#save");
  await options.waitForFunction(() => document.querySelector("#status")?.dataset.state === "ok");
  assert.equal(intake.at(-1).auth, "Bearer e2e-token");
  assert.deepEqual(intake.at(-1).body, {});
  await options.close();
});

test("follow: the page's signals go to the intake, then Claude opens with /follow", async () => {
  const article = await context.newPage();
  await article.goto(`${origin}/guardian-profile.html`);
  const popup = await extensionPage("popup.html");
  await popup.waitForFunction(() => document.querySelector("#page")?.textContent !== "");
  const claude = context.waitForEvent("page", (page) => page.url().startsWith("https://claude.ai/"));
  const sent = intake.length;
  await popup.click("#follow");
  const opened = await claude;

  const { auth, body } = intake[sent];
  assert.equal(auth, "Bearer e2e-token");
  assert.equal(body.url, `${origin}/guardian-profile.html`);
  assert.deepEqual(body.feeds, [{ url: `${origin}/profile/david-adler/rss`, title: "David Adler | The Guardian" }]);
  assert.ok(!JSON.stringify(body).includes("Private reader text"));
  assert.equal(new URL(opened.url()).searchParams.get("q"), `/follow ${origin}/guardian-profile.html`);
  await opened.close();
  await article.close();
});

test("follow: a refused token says so and opens nothing", async () => {
  intakeStatus = 401;
  const article = await context.newPage();
  await article.goto(`${origin}/substack-post.html`);
  const popup = await extensionPage("popup.html");
  await popup.waitForFunction(() => document.querySelector("#page")?.textContent !== "");
  const pagesBefore = context.pages().length;
  await popup.click("#follow");
  await popup.waitForFunction(() => document.querySelector("#status")?.dataset.state === "error");
  assert.match(await popup.textContent("#status"), /token/);
  assert.equal(context.pages().length, pagesBefore);
  intakeStatus = 200;
  await popup.close();
  await article.close();
});
