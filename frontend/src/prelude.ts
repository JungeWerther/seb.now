// What the other scripts build on: Result, the { data, error } shape values
// travel in, and Mapping/Cases, the tables that stand in for if-chains.
// A script like the others (see README.md), inlined first.

// What failed. Never null, which is how a Result says nothing did.
type Failure = object;

// A value, or the reason there is none. supabase-js answers in this shape,
// so its responses are Results as they come.
type Result<T, E extends Failure = Failure> = { data: T; error: null } | { data: null; error: E };

// A Result not computed yet, `() => Promise<Result<T>>`, or computed from
// arguments A when asked for.
type Lazy<T, A extends unknown[] = [], E extends Failure = Failure> = (...args: A) => Promise<Result<T, E>>;

type Ok<T> = Extract<Result<T>, { error: null }>;

const Result = {
  isOk: <T, E extends Failure>(result: Result<T, E>): result is Ok<T> => result.error === null,
  ok: <T>(data: T): Result<T, never> => ({ data, error: null }),
  fail: <E extends Failure>(error: E): Result<never, E> => ({ data: null, error }),
  map: <T, U, E extends Failure>(result: Result<T, E>, f: (data: T) => U): Result<U, E> =>
    Result.isOk(result) ? Result.ok(f(result.data)) : result,
  // Bind: the next step runs only on a value, and may fail itself.
  chain: async <T, U, E extends Failure>(
    result: Result<T, E> | Promise<Result<T, E>>,
    f: (data: T) => Result<U, E> | Promise<Result<U, E>>,
  ): Promise<Result<U, E>> => {
    const r = await result;
    return Result.isOk(r) ? f(r.data) : r;
  },
  // The value, or `fallback` once `onError` has seen why there is none.
  unwrapOr: <T, U, E extends Failure>(result: Result<T, E>, fallback: U, onError: (error: E) => void = () => undefined): T | U => {
    if (Result.isOk(result)) return result.data;
    onError(result.error);
    return fallback;
  },
  // A Result that may still reject, as one that never does.
  settle: <T>(promise: Promise<Result<T>>): Promise<Result<T>> =>
    promise.catch((error: unknown) => Result.fail(typeof error === "object" && error !== null ? error : new Error(String(error)))),
  // A plain promise as a Result.
  attempt: <T>(promise: Promise<T>): Promise<Result<T>> => Result.settle(promise.then(Result.ok)),
};

// A V for every K: a lookup instead of an if-chain. Named `<value>By<K>`
// (test/conventions.test.mjs).
type Mapping<K extends PropertyKey, V> = Readonly<Record<K, V>>;

// A case for every K, each taking the members of U that have K as a field:
// a match over an untagged union. Named like a Mapping.
type Cases<K extends string, U extends object, R> = { readonly [F in K]: (value: Extract<U, Record<F, unknown>>) => R };

const NO_CASE = "no case matches the value's fields";

// The first key of `table` that `value` has as a field.
function fieldOf<K extends string>(table: Mapping<K, unknown>, value: object): K {
  const field = (Object.keys(table) as K[]).find((key) => key in value);
  if (field === undefined) throw new TypeError(NO_CASE);
  return field;
}

// `value` through the case for its field.
function match<K extends string, U extends object, R>(cases: Cases<K, U, R>, value: U): R {
  return (cases[fieldOf(cases, value)] as (value: U) => R)(value);
}
