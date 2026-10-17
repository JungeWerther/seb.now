// Runs the page's own query-reading functions (pulled out of the template
// verbatim) on stubbed indexes, to check how typed text becomes senses.
import { readFileSync } from "node:fs";

const html = readFileSync(process.argv[2], "utf8");
// Filter lives in frontend/src/filter.ts; site.py inlines its compiled script
// into the page, so it's prepended here the same way.
const filterJs = readFileSync(new URL("../../src/seb_now/templates/filter.js", import.meta.url), "utf8");

// The source of a top-level `function name(...) {...}` or `const name = ...;`.
function grab(name) {
  const fn = html.search(new RegExp(`\\n    (async )?function ${name}\\(`));
  const cst = html.search(new RegExp(`\\n    (const|let) ${name}\\b`));
  const start = fn >= 0 ? fn : cst;
  if (start < 0) throw new Error(`missing ${name}`);
  let i = html.indexOf(fn >= 0 ? "{" : "=", start);
  if (fn < 0) {
    // const: up to the first ";\n" at depth 0
    let depth = 0;
    for (; i < html.length; i++) {
      const c = html[i];
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      else if (c === ";" && depth === 0) return html.slice(start, i + 1);
    }
  }
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const names = ["QUERY_PREFIX_MIN_LENGTH", "QUERY_STOPWORDS", "QUERY_SORT_WORDS", "QUERY_FILLER_WORDS",
  "queryWords", "wordMatches", "kindName", "entityKindLabel", "localNow", "indexicalSense", "typedIndexical", "typedFilter",
  "localFilterResults", "filterLocalLinks"];
const src = filterJs + "\n" + names.map(grab).join("\n") + `
let kindIndex = [], indexicalIndex = [], entityIndex = null;
const queryContext = { focus: null };
return { typedFilter, typedIndexical, filterLocalLinks, set(k, i, f) { kindIndex = k; indexicalIndex = i; queryContext.focus = f; },
  index(x) { entityIndex = x; } };`;
const page = new Function(src)();

const kinds = [
  { path: "entity.event", label: "Event", names: ["Event"] },
  { path: "entity.place", label: "Place", names: ["Place"] },
  { path: "entity.period", label: "Period", names: ["Period"] },
];
const indexicals = [
  { term: "tonight", kind_path: "entity.period", context: "time" },
  { term: "tomorrow", kind_path: "entity.period", context: "time" },
  { term: "this", kind_path: "entity", context: "focus" },
];
const paris = { id: "p1", seq: 1, name: "Paris", kind: "place", kind_path: "entity.place" };
const tonightFilm = { id: "w1", seq: 2, name: "Tonight", kind: "work", kind_path: "entity.artifact.work" };
const eventEntity = { id: "e9", seq: 3, name: "Event", kind: "work", kind_path: "entity.artifact.work" };

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
};
// `at` varies with the clock: replace it to compare.
const norm = (f) => f && JSON.parse(JSON.stringify(f).replace(/"at":"[^"]+"/g, '"at":"NOW"'));

page.set(kinds, indexicals, null);
check("event tonight → kind ∧ indexical",
  norm(page.typedFilter("event tonight", [])),
  { terms: [{ kind: "entity.event" }, { indexical: "tonight", at: "NOW" }], local: null, log: [{ kind: "kind", label: "Event" }, { kind: "period", label: "tonight" }] });
check("tonight alone", norm(page.typedFilter("tonight", [])).terms, [{ indexical: "tonight", at: "NOW" }]);
check("tonight + film Tonight → one superposed term",
  norm(page.typedFilter("tonight", [tonightFilm])),
  { terms: [{ any: [{ indexical: "tonight", at: "NOW" }, { entities: ["w1"] }] }], local: null, log: [{ kind: "period / work", label: "tonight" }] });
check("event (kind) + entity Event → superposed",
  norm(page.typedFilter("event paris", [eventEntity, paris])).terms,
  [{ any: [{ kind: "entity.event" }, { entities: ["e9"] }] }, { entities: ["p1"] }]);
check("events tomorrow in paris (plural, filler)",
  norm(page.typedFilter("events tomorrow in paris", [paris])).terms,
  [{ kind: "entity.event" }, { indexical: "tomorrow", at: "NOW" }, { entities: ["p1"] }]);
const belfast = { id: "b1", seq: 5, name: "Belfast", kind: "place", kind_path: "entity.place" };
const manOfTomorrow = { id: "w2", seq: 6, name: "Man of Tomorrow", kind: "work", kind_path: "entity.artifact.work" };
const belfastTelegraph = { id: "c1", seq: 7, name: "Belfast Telegraph", kind: "company", kind_path: "entity.agent.org.company" };
check("tomorrow in belfast → indexical ∧ place, longer partial names skipped",
  norm(page.typedFilter("tomorrow in belfast", [belfast, manOfTomorrow, belfastTelegraph])).terms,
  [{ indexical: "tomorrow", at: "NOW" }, { entities: ["b1"] }]);
check("an unplaced word → not a filter", page.typedFilter("tonight jazz", []), null);
check("this on the plain feed → not a filter", page.typedFilter("this tonight", []), null);
check("typedIndexical('this') off-page → none", page.typedIndexical("this"), null);

page.set(kinds, indexicals, { focus: { entity: "p1" }, name: "Paris" });
check("tonight this, on the Paris page",
  norm(page.typedFilter("tonight this", [])),
  { terms: [{ indexical: "tonight", at: "NOW" }, { indexical: "this", focus: { entity: "p1" } }], local: null, log: [{ kind: "period", label: "tonight" }, { kind: "entity", label: "this · Paris" }] });
check("typedIndexical('this') on a page", page.typedIndexical("this")?.term, "this");
check("at is local wall-clock time", /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(page.typedFilter("tonight", []).terms[0].at), true);

// The page's own index: entities by seq (1 Paris, 2 the film Tonight, 3 a
// work called Event, 4 a jazz festival), which links mention them, minutes.
page.index({
  version: 1,
  entities: new Map([
    [1, { seq: 1, name: "Paris", kind_path: "entity.place" }],
    [2, { seq: 2, name: "Tonight", kind_path: "entity.artifact.work" }],
    [3, { seq: 3, name: "Event", kind_path: "entity.artifact.work" }],
    [4, { seq: 4, name: "Jazz Festival", kind_path: "entity.event" }],
  ]),
  entityLinks: new Map([[1, [10, 11, 13]], [2, [12]], [3, [13]], [4, [11]]]),
  links: new Map([[10, { minute: 100 }], [11, { minute: 200 }], [12, { minute: 300 }], [13, { minute: 400 }]]),
});
const eventParis = page.typedFilter("event paris", [eventEntity, paris]);
check("event paris runs locally, the term a disjunction",
  eventParis.local, [{ any: [{ kind: "entity.event" }, { seqs: [3] }] }, { seqs: [1] }]);
check("local: (Event kind ∨ work 'Event') ∧ Paris, newest first",
  page.filterLocalLinks(eventParis.local).map((r) => [r.linkSeq, [...r.entitySeqs].sort()]), [[13, [1, 3]], [11, [1, 4]]]);
check("local: a lone kind still works", page.filterLocalLinks([{ kind: "entity.event" }]).map((r) => r.linkSeq), [11]);
check("an indexical sense keeps the filter off the local index",
  page.typedFilter("tonight paris", [paris]).local, null);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
