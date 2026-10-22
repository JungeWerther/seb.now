// Runs the built page (page_harness.mjs) with one link, to check when a row
// counts as seen: only after SEEN_DWELL_MS on screen while the page is
// visible, with seen_at the moment its dwell ended.
import { USER_ID, checker, openPage as open, servePage } from "./page_harness.mjs";

const LINK_ID = "11111111-1111-1111-1111-111111111111";
const link = { id: LINK_ID, url: "https://example.com/a", title: "A seen-links test row",
  created_at: new Date().toISOString(), author: null, image_url: null, description: null,
  link_topics: [], link_entities: [], seq: 1 };
const { browser, origin, close } = await servePage({
  ranked_feed: [{ link_id: LINK_ID, rank: 1 }],
  feed_query: [{ link_id: LINK_ID, rank: 1 }],
  links: [link],
}, 8765);
const openPage = () => open(browser, origin);
const { check, failed } = checker();

const setVisibility = (page, state) => page.evaluate((s) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);
const seenWrites = (page) => page.evaluate(() => window.__calls.filter((c) => c.table === "link_impressions"));

{
  const { page, errors } = await openPage();
  await page.waitForTimeout(1500);
  const hiddenAt = Date.now();
  await setVisibility(page, "hidden");
  await page.waitForTimeout(300);
  const writes = await seenWrites(page);
  check("a row on screen for a full second is recorded once", writes.length, 1);
  check("as this reader and link", [writes[0]?.args[0][0].viewer_id, writes[0]?.args[0][0].link_id],
    [USER_ID, LINK_ID]);
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

await close();
process.exit(failed() ? 1 : 0);
