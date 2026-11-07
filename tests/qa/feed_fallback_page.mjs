// Runs the built page (page_harness.mjs) with ranked_feed failing, as it does
// when the ranking query times out: the newest links must replace whatever
// the build pre-rendered, and typing "latest" must still list them newest first.
import { checker, openPage, servePage } from "./page_harness.mjs";

const row = (id, title, minutesAgo) => ({ id, url: `https://example.com/${id}`, title,
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), author: null, image_url: null,
  description: null, link_topics: [], link_entities: [], seq: 1 });
const NEWEST = row("22222222-2222-2222-2222-222222222222", "Ingested after the build", 1);
const { browser, origin, close } = await servePage({
  ranked_feed: { error: "canceling statement due to statement timeout" },
  feed_query: [{ link_id: NEWEST.id, rank: 1 }],
  links: [NEWEST],
}, 8766);
const { check, failed } = checker();
const titles = (page) => page.$$eval("ul.articles li.article .article-row a", (as) => as.map((a) => a.textContent.trim()));

const { page, errors } = await openPage(browser, origin);
await page.waitForTimeout(500);
check("ranking failed: the newest links are listed", await titles(page), [NEWEST.title]);
check("the fake keeps an error through .eq and .single", await page.evaluate(async () => {
  const { data, error } = await window.supabase.createClient().rpc("ranked_feed").eq("link_id", "x").single();
  return [data, error?.message];
}), [null, "canceling statement due to statement timeout"]);

await page.evaluate(() => { window.__calls.length = 0; });
await page.fill("#search-input", "latest");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const sorts = await page.evaluate(() => window.__calls.filter((c) => c.table === "feed_query").map((c) => c.args[0].sort));
check("a typed latest asks for the latest order", sorts.at(-1), "latest");
check("and lists it", await titles(page), [NEWEST.title]);
check("no script errors", errors.filter((e) => !e.includes("ERR_")), []);
await page.close();
await close();
if (failed()) process.exit(1);
