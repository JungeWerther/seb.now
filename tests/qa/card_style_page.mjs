// Runs the built page (page_harness.mjs) with replies from three authors, to
// check card styles: a reply shows in its author's card style (and only if the
// style reads as its type), card types stay out of the Appearance picks, and
// the editor shows each colour pair's contrast, saves only a readable style,
// and restyles your own replies when it does.
import { USER_ID, checker, openPage, servePage } from "./page_harness.mjs";

const COLOR = { type: "string", pattern: "^#[0-9a-f]{6}([0-9a-f]{2})?$" };
const LENGTH = { type: "string", pattern: "^(0|[0-9]{1,4}(\\.[0-9]{1,3})?(px|rem|em|vw|vh|%))$" };
const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["card_accent", "card_bg", "card_fg"],
  properties: { card_bg: { $ref: "#/$defs/color" }, card_fg: { $ref: "#/$defs/color" }, card_accent: { $ref: "#/$defs/color" } },
  $defs: { color: COLOR },
};
const card = { path: "entity.style.card", label: "Card", schema: CARD_SCHEMA, style_scope: "author" };
const layout = { path: "entity.style.layout", label: "Layout", style_scope: "page", schema: {
  type: "object", additionalProperties: false, required: ["column_width", "dock_width"],
  properties: { column_width: { $ref: "#/$defs/length" }, dock_width: { $ref: "#/$defs/length" } }, $defs: { length: LENGTH } } };
const NIGHT = { card_bg: "#1e1b4b", card_fg: "#f5f5f4", card_accent: "#fbbf24" };
const LINK = { id: "11111111-1111-1111-1111-111111111111", url: "https://example.com/a", title: "A row",
  created_at: new Date().toISOString(), author: null, image_url: null, description: null,
  link_topics: [], link_entities: [], seq: 1 };
const reply = (id, author_id, handle, card_style) => ({ id, link_id: LINK.id, author_id, body: `reply by ${handle}`,
  created_at: new Date().toISOString(), profiles: { handle, card_style }, remote_actors: null });

const { browser, origin, close } = await servePage({
  ranked_feed: [{ link_id: LINK.id, rank: 1 }],
  links: [LINK],
  replies: [
    reply("r1", "a1", "night", { style: NIGHT, kinds: { schema: CARD_SCHEMA } }),
    reply("r2", "a2", "plain", null),
    reply("r3", "a3", "sneaky", { style: { ...NIGHT, card_bg: "url(https://x/?leak)" }, kinds: { schema: CARD_SCHEMA } }),
    reply("r4", USER_ID, "me", null),
  ],
  kinds: [card],
  style_contrast_pairs: [
    { kind_path: "entity.style.card", foreground: "card_fg", background: "card_bg", min_ratio: 4.5 },
    { kind_path: "entity.style.card", foreground: "card_accent", background: "card_bg", min_ratio: 3 },
  ],
  profiles: [{ id: USER_ID, card_style: null }],
  entities: [
    { id: "s1", name: "seb.now layout", kind_path: layout.path, style: { column_width: "720px", dock_width: "480px" }, kinds: layout },
    { id: "s2", name: "card a1", kind_path: card.path, style: NIGHT, kinds: card },
  ],
}, 8768);
const { check, failed } = checker();

const replyStyle = (page, handle) => page.evaluate((body) => {
  const item = [...document.querySelectorAll("ul.articles li.reply")].find((li) => li.textContent.includes(body));
  return item && { styled: item.classList.contains("styled"), bg: item.style.getPropertyValue("--card-bg"),
    fg: item.style.getPropertyValue("--card-fg"), shown: getComputedStyle(item).backgroundColor };
}, `reply by ${handle}`);

const { page, errors } = await openPage(browser, origin);
await page.waitForFunction(() => document.querySelectorAll("ul.articles li.reply").length === 4);
check("a reply shows in its author's card style", await replyStyle(page, "night"),
  { styled: true, bg: "#1e1b4b", fg: "#f5f5f4", shown: "rgb(30, 27, 75)" });
check("a reply by an author without one keeps the page's look", (await replyStyle(page, "plain")).styled, false);
check("a style its type refuses sets only what it allows",
  await replyStyle(page, "sneaky").then(({ bg, fg }) => ({ bg, fg })), { bg: "", fg: "#f5f5f4" });

await page.click("#menu-btn");
await page.click('[data-overlay="appearance-overlay"]');
await page.waitForSelector("#appearance-list button");
check("card styles aren't page picks", await page.$$eval(".style-type-label", (labels) => labels.map((l) => l.textContent)),
  ["Layout", "Your replies"]);
await page.waitForSelector("#card-style-editor:not([hidden])");
const contrast = () => page.$$eval("#card-style-contrast li", (items) => items.map((li) => [li.textContent, li.className]));
const saveDisabled = () => page.$eval("#card-style-save", (b) => b.disabled);
const setColor = (token, value) => page.$eval(`#card-style-editor input[data-token="${token}"]`, (input, v) => {
  input.value = v;
  input.dispatchEvent(new Event("input"));
}, value);
check("a new style starts from the page's colours, which are readable", await saveDisabled(), false);
await setColor("card_bg", "#1e1b4b");
await setColor("card_fg", "#3f3a6b");
await setColor("card_accent", "#fbbf24");
check("each pair's contrast is shown, a close one marked", await contrast(), [
  ["Text on Background: 1.5:1, needs 4.5:1", "fail"],
  ["Name on Background: 9.6:1", ""],
]);
check("and a style that fails can't be saved", await saveDisabled(), true);
await setColor("card_fg", "#f5f5f4");
check("a readable one can", [await saveDisabled(), (await contrast()).map(([, c]) => c)], [false, ["", ""]]);
check("the preview shows it", await page.$eval(".card-style-preview .reply", (li) => getComputedStyle(li).backgroundColor),
  "rgb(30, 27, 75)");
await page.click("#card-style-save");
await page.waitForFunction(() => document.getElementById("card-style-status").textContent.startsWith("Saved"));
const writes = await page.evaluate(() => window.__calls.filter((c) => c.table === "entities" || c.table === "profiles")
  .map((c) => [c.table, c.op, c.args[0]]));
check("saving adds your card style and points your profile at it", writes.map(([t, op, a]) => [t, op, a.kind_path ?? Object.keys(a)]),
  [["entities", "insert", "entity.style.card"], ["profiles", "update", ["card_style_id"]]]);
check("with the colours you picked", writes[0][2].style, { card_bg: "#1e1b4b", card_fg: "#f5f5f4", card_accent: "#fbbf24" });
check("and your own replies on the page take it", (await replyStyle(page, "me")).bg, "#1e1b4b");
check("no script errors", errors, []);

await close();
process.exit(failed() ? 1 : 0);
