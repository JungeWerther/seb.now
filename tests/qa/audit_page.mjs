// Runs the built page (page_harness.mjs) with a few links, to check what the
// Modern Web Guidance audit changed: votes without swiping (the score toggles
// an upvote, the bin downvotes with an undo toast in a status region), the
// date as the card's own link with focus following the view, overlays that a
// tap on their own padding doesn't close, IME-safe Enter, a reply box that
// sizes itself in CSS, and rows past the first screen skipped until near it.
// Run: CHROMIUM_PATH=… node audit_page.mjs (from tests/qa, after npm i).
import { checker, openPage as open, servePage } from "./page_harness.mjs";

const ids = [1, 2, 3, 4, 5, 6].map((n) => `${n}`.repeat(8) + "-1111-1111-1111-111111111111");
const links = ids.map((id, i) => ({
  id, url: `https://example.com/${i}`, title: `Audit row ${i}`, created_at: new Date(Date.now() - i * 60000).toISOString(),
  author: null, image_url: null, description: null, link_topics: [], link_entities: [], seq: i + 1,
}));
const { browser, origin, close } = await servePage({
  ranked_feed: ids.map((link_id, i) => ({ link_id, rank: 10 - i })),
  feed_query: ids.map((link_id, i) => ({ link_id, rank: 10 - i })),
  related_feed: [],
  links,
}, 8771);
const { check, failed } = checker();
const votes = (page) => page.evaluate(() => window.__calls.filter((c) => c.table === "votes").map((c) => [c.op, c.args[0]?.value ?? null]));

{
  const { page, errors } = await open(browser, origin);
  await page.waitForTimeout(800);
  const first = page.locator("ul.articles li.article").first();
  const up = first.locator(".post-footer .score");

  await up.click();
  await page.waitForTimeout(200);
  check("the score button upvotes", await votes(page), [["upsert", 1]]);
  check("and is pressed", await up.getAttribute("aria-pressed"), "true");
  await up.click();
  await page.waitForTimeout(200);
  check("pressing it again clears the upvote", (await votes(page)).at(-1), ["delete", null]);
  check("and it is no longer pressed", await up.getAttribute("aria-pressed"), "false");
  check("its name says what it does", (await up.textContent()).trim().startsWith("Upvote, score"), true);

  const second = page.locator("ul.articles li.article").nth(1);
  await second.locator(".vote-down").click();
  await page.waitForTimeout(400);
  check("the bin downvotes", (await votes(page)).at(-1), ["upsert", -1]);
  check("and the undo toast is in a status region", await page.evaluate(() =>
    document.querySelector(".toast")?.parentElement.getAttribute("role")), "status");
  await page.locator(".toast .undo").click();
  await page.waitForTimeout(300);
  check("undo removes the downvote", (await votes(page)).at(-1), ["delete", null]);
  check("and shows the row again", await second.evaluate((li) => li.style.maxHeight), "");

  check("the first rows render", await first.evaluate((li) => getComputedStyle(li).contentVisibility), "visible");
  check("rows past the first screen skip rendering until near it",
    await page.locator("ul.articles li.article").nth(4).evaluate((li) => getComputedStyle(li).contentVisibility), "auto");

  // The date opens the post's page in place, and focus moves into it.
  await first.locator(".permalink").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("Enter on the date opens the post's page", new URL(page.url()).pathname, `/p/${ids[0]}`);
  check("focus moves to the page just opened", await page.evaluate(() => document.activeElement?.id), "focus");
  await page.locator("#focus-back").click();
  await page.waitForTimeout(700);
  check("← Feed goes back", new URL(page.url()).pathname, "/");
  check("focus returns to the card that was opened", await page.evaluate(() =>
    document.activeElement?.closest("li.article")?.dataset.linkId), ids[0]);
  check("no script errors", errors, []);
  await page.close();
}

{
  const { page, errors } = await open(browser, origin);
  await page.locator("#menu-btn").click();
  await page.locator(".bubble[data-overlay='profile-overlay']").click();
  const dialog = page.locator("#profile-overlay");
  const box = await dialog.boundingBox();
  // Inside the dialog's box but on its padding, where the target is the dialog itself.
  await page.mouse.click(box.x + 4, box.y + box.height - 4);
  check("a tap on the overlay's padding leaves it open", await dialog.evaluate((d) => d.open), true);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 40);
  check("a tap on the backdrop closes it", await dialog.evaluate((d) => d.open), false);

  await page.locator("#menu-btn").click();
  await page.locator(".bubble[data-overlay='profile-overlay']").click();
  await page.locator("#handle-input").fill("someone");
  const updates = () => page.evaluate(() => window.__calls.filter((c) => c.table === "profiles" && c.op === "update").length);
  await page.locator("#handle-input").evaluate((input) => input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  await page.waitForTimeout(200);
  check("an Enter confirming an IME composition doesn't save", await updates(), 0);
  await page.locator("#handle-input").evaluate((input) => input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })));
  await page.waitForTimeout(200);
  check("nor does one reporting keyCode 229 (Safari)", await updates(), 0);
  await page.locator("#handle-input").press("Enter");
  await page.waitForTimeout(300);
  check("a plain Enter saves", await updates(), 1);
  await page.keyboard.press("Escape");

  check("the reply box sizes to its contents in CSS", await page.evaluate(() =>
    getComputedStyle(document.getElementById("reply-input")).fieldSizing), "content");
  check("no script errors", errors, []);
  await page.close();
}

await close();
if (failed()) process.exit(1);
