// Caching as wrappers. Each keeps the promise, so concurrent callers share one
// load, and drops a load that fails (a rejection, or null for `memoize`) so the
// next call tries again.

// `load`, run at most once successfully.
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return () =>
    value ??= load().catch((error) => {
      value = null;
      throw error;
    });
}

export interface Memoized<A extends unknown[], V> {
  (...args: A): Promise<V>;
  // Stores a value already known for `args`, as if `load` had returned it
  // (so null is not kept).
  prime: (args: A, value: V) => void;
}

// `load` memoized by `key`, keeping the `maxEntries` most recently used.
export function memoize<A extends unknown[], V>(
  key: (...args: A) => string,
  load: (...args: A) => Promise<V>,
  { maxEntries }: { maxEntries: number },
): Memoized<A, V> {
  const entries = new Map<string, Promise<V>>();
  const keep = (k: string, value: Promise<V>) => {
    // Map keeps insertion order: re-inserting marks it most recently used.
    entries.delete(k);
    entries.set(k, value);
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  };
  const forget = (k: string, value: Promise<V>) => {
    if (entries.get(k) === value) entries.delete(k);
  };
  const memoized = (...args: A) => {
    const k = key(...args);
    const hit = entries.get(k);
    if (hit) {
      keep(k, hit);
      return hit;
    }
    const value: Promise<V> = load(...args).then(
      (v) => {
        if (v === null) forget(k, value);
        return v;
      },
      (error) => {
        forget(k, value);
        throw error;
      },
    );
    keep(k, value);
    return value;
  };
  const prime = (args: A, value: V) => {
    const k = key(...args);
    if (value === null) entries.delete(k);
    else keep(k, Promise.resolve(value));
  };
  return Object.assign(memoized, { prime });
}
