// The page script's feed paging, pulled out of index.html verbatim and run
// on a stubbed supabase client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const templates = new URL("../../src/seb_now/templates/", import.meta.url);
const html = readFileSync(new URL("index.html", templates), "utf8");
const compiled = (name) => readFileSync(new URL(`${name}.js`, templates), "utf8");

// The source of a top-level `function name(...) {...}` or `const name = ...;`.
function grab(name) {
  const fn = html.search(new RegExp(`\\n    (async )?function ${name}\\(`));
  const start = fn >= 0 ? fn : html.search(new RegExp(`\\n    (const|let) ${name}\\b`));
  assert.ok(start >= 0, `missing ${name}`);
  let i = fn >= 0 ? html.indexOf(") {", start) + 2 : html.indexOf("=", start);
  let depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    if (fn >= 0 ? c === "}" && depth === 0 : c === ";" && depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const NAMES = ["emptyPage", "fetchLinks", "cursorOfRow", "linksInIdOrder", "fetchRanked", "fetchQueried", "linksInOrder",
  "fetchRelated", "fetchEntityLinks", "fetchTopicLinks", "fetchKindLinks", "fetchFiltered", "fetchServerFiltered",
  "linkRowsBySeq", "fetchLocalFiltered", "linksWithMatches", "pageFetcherByFeedField", "fetchPage", "keyset", "escapeLike"];

// A page script whose client answers each request once `release()` is called.
function page() {
  return new Function(`${compiled("prelude")}\n${compiled("filter")}
const FEED_PAGE_SIZE = 2, FEED_SELECT = "*";
const pending = [];
const rows = [{ id: "a", created_at: "2" }, { id: "b", created_at: "1" }];
const query = () => {
  const q = { select: () => q, in: () => q, ilike: () => q, or: () => q, order: () => q, limit: () => q,
    then: (resolve) => pending.push(() => resolve({ data: rows.map((r) => ({ ...r })), error: null })) };
  return q;
};
const client = { from: query, rpc: query };
const supabaseReady = Promise.resolve(client), pendingSession = Promise.resolve(true);
const entityIndex = { ready: false };
const feed = { generation: 0, query: "", intent: null, related: null, entity: null, topic: null, filter: null,
  indexical: null, term: null, kind: null, chronological: false, offset: 0, cursor: null };
${NAMES.map(grab).join("\n")}
const release = async () => { while (pending.length) { pending.shift()(); await new Promise((r) => setTimeout(r)); } };
return { feed, fetchPage, release };`)();
}

test("a page lists rows and moves the feed on", async () => {
  const p = page();
  p.feed.query = "x";
  const loading = p.fetchPage();
  await new Promise((r) => setTimeout(r));
  await p.release();
  const { data, error } = await loading;
  assert.equal(error, null);
  assert.deepEqual(data.rows.map((r) => r.id), ["a", "b"]);
  assert.equal(p.feed.offset, 2);
  assert.deepEqual({ ...p.feed.cursor }, { createdAt: "1", id: "b" });
});

test("a page for a feed that was replaced leaves the new feed's offset and cursor alone", async () => {
  const p = page();
  p.feed.query = "x";
  const stale = p.fetchPage();
  await new Promise((r) => setTimeout(r));
  // The reader clears the search: a new feed starts from the top.
  Object.assign(p.feed, { generation: 1, query: "", offset: 0, cursor: null });
  await p.release();
  await stale;
  assert.equal(p.feed.offset, 0);
  assert.equal(p.feed.cursor, null);
});
