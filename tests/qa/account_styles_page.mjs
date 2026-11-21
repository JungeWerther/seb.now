// Runs the built page (page_harness.mjs) for a reader whose account holds a
// style pick in style_picks (as set on another device, or by an agent through
// the MCP server's pick_style): the page applies it though this browser has
// no pick of its own, and picking in Appearance writes the account's pick
// (changed for a style, dropped for Default).
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
const LINK = { id: "11111111-1111-1111-1111-111111111111", url: "https://example.com/a", title: "A row",
  created_at: new Date().toISOString(), author: null, image_url: null, description: null,
  link_topics: [], link_entities: [], seq: 1 };

const { browser, origin, close } = await servePage({
  ranked_feed: [{ link_id: LINK.id, rank: 1 }],
  links: [LINK],
  entities: [BUILT_IN, WIDE],
  style_picks: [{ type_path: kinds.path, style: WIDE }],
}, 8781);
const { check, failed } = checker();

const column = (page) => page.evaluate(() => document.documentElement.style.getPropertyValue("--column-width"));
const pickWrites = (page) => page.evaluate(() =>
  window.__calls.filter((c) => c.table === "style_picks").map((c) => c.op));
async function pick(page, name) {
  await page.click("#menu-btn");
  await page.click('[data-overlay="appearance-overlay"]');
  await page.waitForSelector("#appearance-list button");
  await page.click(`#appearance-list button:text-is("${name}")`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

{
  const { page, errors } = await openPage(browser, origin);
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--column-width") !== "");
  check("the account's pick applies with no pick in this browser", await column(page), "1000px");
  check("and is kept for the next first paint", await page.evaluate(() =>
    Object.keys(JSON.parse(localStorage.getItem("seb-now-styles") ?? "{}"))), [kinds.path]);
  await pick(page, "seb.now layout");
  check("picking a style changes the account's pick", await pickWrites(page), ["update"]);
  await pick(page, "Default");
  check("Default drops it", await pickWrites(page), ["update", "delete"]);
  check("no script errors", errors, []);
  await page.close();
}

await close();
if (failed()) process.exit(1);
