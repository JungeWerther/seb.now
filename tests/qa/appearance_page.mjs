// Runs the built page (page_harness.mjs) with three layout styles, to check
// the Appearance menu: picking a style sets its tokens as custom properties
// (and the column follows), the pick survives a reload, a value its type
// refuses is left out, picking the built-in style clears the pick, and a
// picked style deleted since is dropped.
import { checker, openPage, servePage } from "./page_harness.mjs";

const LENGTH = { type: "string", pattern: "^(0|[0-9]{1,4}(\\.[0-9]{1,3})?(px|rem|em|vw|vh|%))$" };
const kinds = {
  path: "entity.style.layout",
  label: "Layout",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["column_width", "dock_width"],
    properties: { column_width: { $ref: "#/$defs/length" }, dock_width: { $ref: "#/$defs/length" } },
    $defs: { length: LENGTH },
  },
};
const style = (id, name, owner_id, values) => ({ id, name, kind_path: kinds.path, owner_id, style: values, kinds });
const BUILT_IN = style("10000000-0000-0000-0000-000000000001", "seb.now layout", null, { column_width: "720px", dock_width: "480px" });
const WIDE = style("10000000-0000-0000-0000-000000000002", "Wide", "u1", { column_width: "1000px", dock_width: "600px" });
// A row the database would refuse, as if it had slipped through.
const BAD = style("10000000-0000-0000-0000-000000000003", "Bad", "u1", { column_width: "1px;}body{display:none", dock_width: "640px" });
const LINK = { id: "11111111-1111-1111-1111-111111111111", url: "https://example.com/a", title: "A row",
  created_at: new Date().toISOString(), author: null, image_url: null, description: null,
  link_topics: [], link_entities: [], seq: 1 };

const { browser, origin, close } = await servePage({
  ranked_feed: [{ link_id: LINK.id, rank: 1 }],
  links: [LINK],
  entities: [BUILT_IN, WIDE, BAD],
}, 8767);
const { check, failed } = checker();

const tokens = (page) => page.evaluate(() => {
  const root = document.documentElement.style;
  return { column: root.getPropertyValue("--column-width"), dock: root.getPropertyValue("--dock-width"),
    body: getComputedStyle(document.body).maxWidth };
});
const stored = (page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("seb-now-styles") ?? "{}")));
const pressed = (page) => page.$$eval("#appearance-list button", (buttons) =>
  buttons.map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`));
async function openAppearance(page) {
  await page.click("#menu-btn");
  await page.click('[data-overlay="appearance-overlay"]');
  await page.waitForSelector("#appearance-list button");
}
async function pick(page, name) {
  await page.click(`#appearance-list button:text-is("${name}")`);
}

const context = await browser.newContext();
{
  const { page, errors } = await openPage(browser, origin, context);
  check("by default no token is overridden", await tokens(page), { column: "", dock: "", body: "730px" });
  await openAppearance(page);
  check("the layout type lists its styles, the built-in one picked",
    await page.$$eval(".style-type-label", (labels) => labels.map((l) => l.textContent)), ["Layout"]);
  check("built-in pressed", await pressed(page), ["seb.now layout:true", "Wide:false", "Bad:false"]);
  await pick(page, "Wide");
  check("picking Wide sets its tokens, and the column follows", await tokens(page),
    { column: "1000px", dock: "600px", body: "1010px" });
  check("Wide pressed", await pressed(page), ["seb.now layout:false", "Wide:true", "Bad:false"]);
  check("the pick is kept", await stored(page), ["entity.style.layout"]);
  check("no script errors", errors, []);
  await page.close();
}
{
  const { page, errors } = await openPage(browser, origin, context);
  check("after a reload the pick still applies", await tokens(page), { column: "1000px", dock: "600px", body: "1010px" });
  await openAppearance(page);
  check("and is shown pressed", await pressed(page), ["seb.now layout:false", "Wide:true", "Bad:false"]);
  await pick(page, "Bad");
  check("a value its type refuses is left out, the others set", await tokens(page),
    { column: "", dock: "640px", body: "730px" });
  await pick(page, "seb.now layout");
  check("picking the built-in style clears the pick", [await tokens(page), await stored(page)],
    [{ column: "", dock: "", body: "730px" }, []]);
  check("no script errors", errors, []);
  await page.close();
}
{
  const { page, errors } = await openPage(browser, origin, context);
  await page.evaluate(() => localStorage.setItem("seb-now-styles", JSON.stringify({ "entity.style.layout": {
    id: "10000000-0000-0000-0000-000000000009", style: { column_width: "900px", dock_width: "500px" },
    schema: { properties: { column_width: { $ref: "#/$defs/length" }, dock_width: { $ref: "#/$defs/length" } },
      $defs: { length: { type: "string", pattern: "^[0-9]+px$" } } } } })));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("ul.articles li.article").length > 0);
  await page.waitForTimeout(300);
  check("a picked style deleted since is dropped", [await tokens(page), await stored(page)],
    [{ column: "", dock: "", body: "730px" }, []]);
  await page.evaluate(() => localStorage.setItem("seb-now-styles", "not json"));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("ul.articles li.article").length > 0);
  check("unreadable stored choices are ignored", await tokens(page), { column: "", dock: "", body: "730px" });
  check("no script errors", errors, []);
  await page.close();
}

await close();
process.exit(failed() ? 1 : 0);
