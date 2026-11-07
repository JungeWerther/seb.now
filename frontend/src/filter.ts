// Typed filter queries ("event paris": the kind Event and the place Paris)
// and the cache in front of filter_links.
//
// This file is a script, not a module: tsc compiles it to
// src/seb_now/templates/filter.js, which site.py inlines into index.html's
// module script (FILTER_JS_PLACEHOLDER), so these declarations are in scope
// there.
// Keep it free of page globals (no DOM, no supabase client): everything the
// page knows comes in as arguments.

// One sense of a typed term, as filter_sense checks it: a link mentioning an
// entity of `kind` (or a subkind) or one of `entities`, labelled with `topic`
// (or below), with an event overlapping `period`, or what an indexical picks
// out read at local time `at` or on the page in `focus`.
type FilterSense =
  | { kind: string }
  | { entities: string[] }
  | { topic: string }
  | { period: [string, string] }
  | { indexical: string; at: string }
  | { indexical: string; focus: Record<string, string> };

// A typed term stands for every sense it has at once (a superposition): a
// link passes it through any of them. A lone sense is sent bare.
type FilterTerm = FilterSense | { any: FilterSense[] };

// The same term for the page's own copy of the entity index: kinds, and
// entities by seq. Events and topics aren't in the index, so a term with an
// indexical, period or topic sense has no local form.
type LocalSense = { kind: string } | { seqs: number[] };
type LocalTerm = LocalSense | { any: LocalSense[] };

// What a filter writes: the chip shown for it above the results.
interface FilterChip {
  kind: string;
  label: string;
}

// A filter is the terms a link must pass plus the chips they write (and the
// same terms for the local index, or null when any can't be read there), and
// whether the links the reader has seen go last ("events in paris, new").
// Filters form a monoid: `unit` passes every link and writes nothing,
// `concat` is conjunction (a link must pass both), appends the logs in order
// and asks for seen-last when either side does. It's the Writer monad's
// append; reading a query is a fold of concat from unit.
interface Filter {
  terms: FilterTerm[];
  local: LocalTerm[] | null;
  log: FilterChip[];
  seenLast: boolean;
}

// Between a chip's kinds, when its senses are of several.
const CHIP_KIND_SEPARATOR = " / ";

const Filter = {
  unit: (): Filter => ({ terms: [], local: [], log: [], seenLast: false }),
  // Passes every link and lists the seen ones last. What a reader has seen
  // isn't in the local index, so it has no local form.
  seenLast: (): Filter => ({ terms: [], local: null, log: [], seenLast: true }),
  // One term with all its senses; `localSenses` is null when one of them
  // can't be read on the local index.
  term: (senses: FilterSense[], label: string, kinds: string[], localSenses: LocalSense[] | null): Filter => ({
    terms: [oneOrAny(senses)],
    local: localSenses && [oneOrAny(localSenses)],
    log: [{ kind: [...new Set(kinds)].join(CHIP_KIND_SEPARATOR), label }],
    seenLast: false,
  }),
  concat: (a: Filter, b: Filter): Filter => ({
    terms: [...a.terms, ...b.terms],
    local: a.local && b.local && [...a.local, ...b.local],
    log: [...a.log, ...b.log],
    seenLast: a.seenLast || b.seenLast,
  }),
};

function oneOrAny<S>(senses: S[]): S | { any: S[] } {
  const [only] = senses;
  return senses.length === 1 && only !== undefined ? only : { any: senses };
}

// The seams of a cache key: between a sense's field and its spelling, the
// ids of one sense, a period's ends, an indexical and what it is read on,
// the senses of a term, the terms of a filter and its order, a filter and
// its cursor, and the cursor's parts.
type KeyPart = "field" | "entity" | "period" | "reading" | "sense" | "term" | "order" | "page" | "cursor";

const separatorByKeyPart: Mapping<KeyPart, string> = {
  field: ":",
  entity: ",",
  period: "/",
  reading: "@",
  sense: "|",
  term: "&",
  order: "#",
  page: "@",
  cursor: "|",
};

// A sense's field, as fieldOf finds it: an indexical by what it is read on.
type SenseField = "kind" | "entities" | "topic" | "period" | "at" | "focus";

// Each sense's spelling, canonical: entity ids sorted, since a sense with
// several entities passes through any of them.
const spellingBySenseField: Cases<SenseField, FilterSense, string> = {
  kind: ({ kind }) => kind,
  entities: ({ entities }) => [...entities].sort().join(separatorByKeyPart.entity),
  topic: ({ topic }) => topic,
  period: ({ period }) => period.join(separatorByKeyPart.period),
  at: ({ indexical, at }) => [indexical, at].join(separatorByKeyPart.reading),
  focus: ({ indexical, focus }) => [indexical, JSON.stringify(Object.entries(focus).sort())].join(separatorByKeyPart.reading),
};

// One sense in a canonical spelling, under its field.
function senseKey(sense: FilterSense): string {
  return [fieldOf(spellingBySenseField, sense), match(spellingBySenseField, sense)].join(separatorByKeyPart.field);
}

// One term in a canonical spelling: its senses deduplicated and sorted, since
// disjunction doesn't care about order or repeats.
function termKey(term: FilterTerm): string {
  const senses = "any" in term ? term.any : [term];
  return [...new Set(senses.map(senseKey))].sort().join(separatorByKeyPart.sense);
}

// The order a seen-last filter is listed in, in its key.
const SEEN_LAST_ORDER = "seen-last";

// The filter's cache key. Conjunction is commutative and idempotent, so
// terms are deduplicated and sorted: "paris event" and "event paris" are the
// same filter. The log is left out; it only decides what the chips say.
function filterKey(filter: Pick<Filter, "terms" | "seenLast">): string {
  const terms = [...new Set(filter.terms.map(termKey))].sort().join(separatorByKeyPart.term);
  return filter.seenLast ? [terms, SEEN_LAST_ORDER].join(separatorByKeyPart.order) : terms;
}

// Where the next page starts: links after this one in the order filter_links
// lists them, (seen, created_at desc, id desc); `seen` is false unless the
// filter is seen-last.
interface FilterCursor {
  seen: boolean;
  createdAt: string;
  id: string;
}

// A row filter_links returns.
interface FilterRow {
  link_id: string;
  entity_ids: string[];
  created_at: string;
  seen: boolean;
}

// The cursor after `rows`, or null when there are none.
function nextFilterCursor(rows: readonly FilterRow[]): FilterCursor | null {
  const last = rows.at(-1);
  return last ? { seen: last.seen, createdAt: last.created_at, id: last.link_id } : null;
}

// The key of one page of `filter`: its filter's key, the moment a seen-last
// filter's seen links are counted at (`asOf`; other filters don't depend on
// it, so their pages are shared across feeds) and where the page starts.
function filterPageKey(filter: Pick<Filter, "terms" | "seenLast">, cursor: FilterCursor | null, asOf: string): string {
  const key = filter.seenLast ? [filterKey(filter), asOf].join(separatorByKeyPart.page) : filterKey(filter);
  return cursor
    ? [key, [String(cursor.seen), cursor.createdAt, cursor.id].join(separatorByKeyPart.cursor)].join(separatorByKeyPart.page)
    : key;
}

// How long a cached page is reused. Keyset pages don't shift when links are
// added, but entity extraction can still tag an older link later, so no page
// is kept forever.
const FILTER_CACHE_TTL_MS = 5 * 60 * 1000;
// Pages kept at most; the least recently used goes first.
const FILTER_CACHE_MAX_PAGES = 50;

interface CacheEntry<V> {
  value: Promise<Result<V>>;
  expires: number;
}

// `load` memoized by key. The promise is what's kept, so a second request for
// a page still in flight shares the first; a failed load (or one that
// rejects, which comes back as a failure) is dropped so the next request
// tries again.
function memoize<A extends unknown[], V>(
  key: (...args: A) => string,
  load: Lazy<V, A>,
  { ttlMs = FILTER_CACHE_TTL_MS, maxEntries = FILTER_CACHE_MAX_PAGES, now = () => Date.now() } = {},
): Lazy<V, A> {
  const entries = new Map<string, CacheEntry<V>>();
  return (...args: A) => {
    const k = key(...args);
    const hit = entries.get(k);
    if (hit && hit.expires > now()) {
      // Map keeps insertion order: re-inserting marks it most recently used.
      entries.delete(k);
      entries.set(k, hit);
      return hit.value;
    }
    const value: Promise<Result<V>> = Result.settle(Promise.resolve(args).then((a) => load(...a))).then((result) => {
      if (!Result.isOk(result) && entries.get(k)?.value === value) entries.delete(k);
      return result;
    });
    entries.delete(k);
    entries.set(k, { value, expires: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return value;
  };
}
