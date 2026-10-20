// What the other scripts build on: Result, the { data, error } shape values
// travel in, and Mapping/Cases, the tables that stand in for if-chains.
// A script like the others (see README.md), inlined first.
const Result = {
    isOk: (result) => result.error === null,
    ok: (data) => ({ data, error: null }),
    fail: (error) => ({ data: null, error }),
    map: (result, f) => Result.isOk(result) ? Result.ok(f(result.data)) : result,
    // Bind: the next step runs only on a value, and may fail itself.
    chain: async (result, f) => {
        const r = await result;
        return Result.isOk(r) ? f(r.data) : r;
    },
    // The value, or `fallback` once `onError` has seen why there is none.
    unwrapOr: (result, fallback, onError = () => undefined) => {
        if (Result.isOk(result))
            return result.data;
        onError(result.error);
        return fallback;
    },
    // A Result that may still reject, as one that never does.
    settle: (promise) => promise.catch((error) => Result.fail(typeof error === "object" && error !== null ? error : new Error(String(error)))),
    // A plain promise as a Result.
    attempt: (promise) => Result.settle(promise.then(Result.ok)),
};
const NO_CASE = "no case matches the value's fields";
// The first key of `table` that `value` has as a field.
function fieldOf(table, value) {
    const field = Object.keys(table).find((key) => key in value);
    if (field === undefined)
        throw new TypeError(NO_CASE);
    return field;
}
// `value` through the case for its field.
function match(cases, value) {
    return cases[fieldOf(cases, value)](value);
}
