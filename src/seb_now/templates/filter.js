// Typed filter queries ("event paris": the kind Event and the place Paris)
// and the cache in front of filter_links.
//
// This file is a script, not a module: tsc compiles it to
// src/seb_now/templates/filter.js, which site.py inlines into index.html's
// module script (FILTER_JS_PLACEHOLDER), so these declarations are in scope
// there.
// Keep it free of page globals (no DOM, no supabase client): everything the
// page knows comes in as arguments.
// Between a chip's kinds, when its senses are of several.
const CHIP_KIND_SEPARATOR = " / ";
const Filter = {
    unit: () => ({ terms: [], local: [], log: [] }),
    // One term with all its senses; `localSenses` is null when one of them
    // can't be read on the local index.
    term: (senses, label, kinds, localSenses) => ({
        terms: [oneOrAny(senses)],
        local: localSenses && [oneOrAny(localSenses)],
        log: [{ kind: [...new Set(kinds)].join(CHIP_KIND_SEPARATOR), label }],
    }),
    concat: (a, b) => ({
        terms: [...a.terms, ...b.terms],
        local: a.local && b.local && [...a.local, ...b.local],
        log: [...a.log, ...b.log],
    }),
};
function oneOrAny(senses) {
    const [only] = senses;
    return senses.length === 1 && only !== undefined ? only : { any: senses };
}
const separatorByKeyPart = {
    field: ":",
    entity: ",",
    period: "/",
    reading: "@",
    sense: "|",
    term: "&",
    page: "@",
    cursor: "|",
};
// Each sense's spelling, canonical: entity ids sorted, since a sense with
// several entities passes through any of them.
const spellingBySenseField = {
    kind: ({ kind }) => kind,
    entities: ({ entities }) => [...entities].sort().join(separatorByKeyPart.entity),
    topic: ({ topic }) => topic,
    period: ({ period }) => period.join(separatorByKeyPart.period),
    at: ({ indexical, at }) => [indexical, at].join(separatorByKeyPart.reading),
    focus: ({ indexical, focus }) => [indexical, JSON.stringify(Object.entries(focus).sort())].join(separatorByKeyPart.reading),
};
// One sense in a canonical spelling, under its field.
function senseKey(sense) {
    return [fieldOf(spellingBySenseField, sense), match(spellingBySenseField, sense)].join(separatorByKeyPart.field);
}
// One term in a canonical spelling: its senses deduplicated and sorted, since
// disjunction doesn't care about order or repeats.
function termKey(term) {
    const senses = "any" in term ? term.any : [term];
    return [...new Set(senses.map(senseKey))].sort().join(separatorByKeyPart.sense);
}
// The filter's cache key. Conjunction is commutative and idempotent, so
// terms are deduplicated and sorted: "paris event" and "event paris" are the
// same filter. The log is left out; it only decides what the chips say.
function filterKey(filter) {
    return [...new Set(filter.terms.map(termKey))].sort().join(separatorByKeyPart.term);
}
// The cursor after `rows`, or null when there are none.
function nextFilterCursor(rows) {
    const last = rows.at(-1);
    return last ? { createdAt: last.created_at, id: last.link_id } : null;
}
// The key of one page of `filter`: its filter's key and where it starts.
function filterPageKey(filter, cursor) {
    const key = filterKey(filter);
    return cursor ? [key, [cursor.createdAt, cursor.id].join(separatorByKeyPart.cursor)].join(separatorByKeyPart.page) : key;
}
// How long a cached page is reused. Keyset pages don't shift when links are
// added, but entity extraction can still tag an older link later, so no page
// is kept forever.
const FILTER_CACHE_TTL_MS = 5 * 60 * 1000;
// Pages kept at most; the least recently used goes first.
const FILTER_CACHE_MAX_PAGES = 50;
// `load` memoized by key. The promise is what's kept, so a second request for
// a page still in flight shares the first; a failed load (or one that
// rejects, which comes back as a failure) is dropped so the next request
// tries again.
function memoize(key, load, { ttlMs = FILTER_CACHE_TTL_MS, maxEntries = FILTER_CACHE_MAX_PAGES, now = () => Date.now() } = {}) {
    const entries = new Map();
    return (...args) => {
        const k = key(...args);
        const hit = entries.get(k);
        if (hit && hit.expires > now()) {
            // Map keeps insertion order: re-inserting marks it most recently used.
            entries.delete(k);
            entries.set(k, hit);
            return hit.value;
        }
        const value = Result.settle(Promise.resolve(args).then((a) => load(...a))).then((result) => {
            if (!Result.isOk(result) && entries.get(k)?.value === value)
                entries.delete(k);
            return result;
        });
        entries.delete(k);
        entries.set(k, { value, expires: now() + ttlMs });
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined)
                break;
            entries.delete(oldest);
        }
        return value;
    };
}
