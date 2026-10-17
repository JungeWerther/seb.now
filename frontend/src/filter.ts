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
// same terms for the local index, or null when any can't be read there).
// Filters form a monoid: `unit` passes every link and writes nothing,
// `concat` is conjunction (a link must pass both) and appends the logs in
// order. It's the Writer monad's append; reading a query is a fold of concat
// from unit.
interface Filter {
  terms: FilterTerm[];
  local: LocalTerm[] | null;
  log: FilterChip[];
}

const Filter = {
  unit: (): Filter => ({ terms: [], local: [], log: [] }),
  // One term with all its senses; `localSenses` is null when one of them
  // can't be read on the local index.
  term: (senses: FilterSense[], label: string, kinds: string[], localSenses: LocalSense[] | null): Filter => ({
    terms: [oneOrAny(senses)],
    local: localSenses && [oneOrAny(localSenses)],
    log: [{ kind: [...new Set(kinds)].join(" / "), label }],
  }),
  concat: (a: Filter, b: Filter): Filter => ({
    terms: [...a.terms, ...b.terms],
    local: a.local && b.local && [...a.local, ...b.local],
    log: [...a.log, ...b.log],
  }),
};

function oneOrAny<S>(senses: S[]): S | { any: S[] } {
  const [only] = senses;
  return senses.length === 1 && only !== undefined ? only : { any: senses };
}

// One sense in a canonical spelling: entity ids sorted, since a sense with
// several entities passes through any of them.
function senseKey(sense: FilterSense): string {
  if ("kind" in sense) return `k:${sense.kind}`;
  if ("entities" in sense) return `e:${[...sense.entities].sort().join(",")}`;
  if ("topic" in sense) return `t:${sense.topic}`;
  if ("period" in sense) return `p:${sense.period[0]}/${sense.period[1]}`;
  if ("at" in sense) return `i:${sense.indexical}@${sense.at}`;
  return `i:${sense.indexical}#${JSON.stringify(Object.entries(sense.focus).sort())}`;
}

// One term in a canonical spelling: its senses deduplicated and sorted, since
// disjunction doesn't care about order or repeats.
function termKey(term: FilterTerm): string {
  const senses = "any" in term ? term.any : [term];
  return [...new Set(senses.map(senseKey))].sort().join("|");
}

// The filter's cache key. Conjunction is commutative and idempotent, so
// terms are deduplicated and sorted: "paris event" and "event paris" are the
// same filter. The log is left out; it only decides what the chips say.
function filterKey(filter: Pick<Filter, "terms">): string {
  return [...new Set(filter.terms.map(termKey))].sort().join("&");
}

// Where the next page starts: links strictly older than this one, by
// (created_at, id), the order filter_links lists them in.
interface FilterCursor {
  createdAt: string;
  id: string;
}

// A row filter_links returns.
interface FilterRow {
  link_id: string;
  entity_ids: string[];
  created_at: string;
}

// The cursor after `rows`, or null when there are none.
function nextFilterCursor(rows: readonly FilterRow[]): FilterCursor | null {
  const last = rows.at(-1);
  return last ? { createdAt: last.created_at, id: last.link_id } : null;
}

// The key of one page of `filter`: its filter's key and where it starts.
function filterPageKey(filter: Pick<Filter, "terms">, cursor: FilterCursor | null): string {
  return cursor ? `${filterKey(filter)}@${cursor.createdAt}|${cursor.id}` : filterKey(filter);
}

// How long a cached page is reused. Keyset pages don't shift when links are
// added, but entity extraction can still tag an older link later, so no page
// is kept forever.
const FILTER_CACHE_TTL_MS = 5 * 60 * 1000;
// Pages kept at most; the least recently used goes first.
const FILTER_CACHE_MAX_PAGES = 50;

interface CacheEntry<V> {
  value: Promise<V | null>;
  expires: number;
}

// `load` memoized by key. The promise is what's kept, so a second request for
// a page still in flight shares the first; a load that fails (null or a
// rejection) is dropped so the next request tries again.
function memoize<A extends unknown[], V>(
  key: (...args: A) => string,
  load: (...args: A) => Promise<V | null>,
  { ttlMs = FILTER_CACHE_TTL_MS, maxEntries = FILTER_CACHE_MAX_PAGES, now = () => Date.now() } = {},
): (...args: A) => Promise<V | null> {
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
    const value = load(...args).then(
      (v) => {
        if (v === null && entries.get(k)?.value === value) entries.delete(k);
        return v;
      },
      (error: unknown) => {
        if (entries.get(k)?.value === value) entries.delete(k);
        throw error;
      },
    );
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
