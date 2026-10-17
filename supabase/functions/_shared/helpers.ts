// Small helpers any function can use: a JSON response, the null filter, and
// `reporting`, which turns a step's failure into a reported null.

export type Row = Record<string, unknown>;
export type Report = (error: Row) => void;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

export const isPresent = <T>(value: T | null): value is T => value !== null;

// `fn`, with a failure reported (tagged by `label`) and read as null. Started
// from a resolved promise, so a synchronous throw is caught the same way.
export function reporting<T, R>(report: Report, label: (item: T) => Row, fn: (item: T) => Promise<R>) {
  return (item: T): Promise<R | null> =>
    Promise.resolve(item).then(fn).catch((e) => {
      report({ ...label(item), error: String(e) });
      return null;
    });
}
