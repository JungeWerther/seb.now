// Typed filter queries ("event paris": the kind Event and the place Paris)
// and the cache in front of filter_links.
//
// This file is a script, not a module: tsc compiles it to
// src/seb_now/templates/filter.js, which site.py inlines into index.html's
// module script (FILTER_JS_PLACEHOLDER), so these declarations are in scope
// there.
// Keep it free of page globals (no DOM, no supabase client): everything the
// page knows comes in as arguments.

// One check filter_links makes: a link mentioning an entity of `kind` (or
// a subkind), or one of `entities` (a typed name can be several entities).
type FilterTerm = { kind: string } | { entities: string[] };

// What a filter writes: the chip shown for it above the results.
interface FilterChip {
  kind: string;
  label: string;
}

// A filter is the terms a link must pass plus the chips they write. Filters
// form a monoid: `unit` passes every link and writes nothing, `concat` is
// conjunction (a link must pass both) and appends the logs in order. It's
// the Writer monad's append; reading a query is a fold of concat from unit.
interface Filter {
  terms: FilterTerm[];
  log: FilterChip[];
}

const Filter = {
  unit: (): Filter => ({ terms: [], log: [] }),
  kind: (path: string, chip: FilterChip): Filter => ({ terms: [{ kind: path }], log: [chip] }),
  entities: (ids: string[], chip: FilterChip): Filter => ({ terms: [{ entities: ids }], log: [chip] }),
  concat: (a: Filter, b: Filter): Filter => ({ terms: [...a.terms, ...b.terms], log: [...a.log, ...b.log] }),
};

// One term in a canonical spelling: entity ids sorted, since disjunction
// inside a term doesn't care about order.
function termKey(term: FilterTerm): string {
  return "kind" in term ? `k:${term.kind}` : `e:${[...term.entities].sort().join(",")}`;
}

// The filter's cache key. Conjunction is commutative and idempotent, so
// terms are deduplicated and sorted: "paris event" and "event paris" are the
// same filter. The log is left out; it only decides what the chips say.
function filterKey(filter: Filter): string {
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
function filterPageKey(filter: Filter, cursor: FilterCursor | null): string {
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
function memoizePages<A extends unknown[], V>(
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
