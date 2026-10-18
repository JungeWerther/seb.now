// Small helpers any function can use: JSON responses, the null filter, `sumBy`,
// and `reporting`, which turns a step's failure into a reported null.

export type Row = Record<string, unknown>;
export type Report = (error: Row) => void;

// A JSON responder with these extra headers, indented by `indent` spaces (none
// when left out): each function declares the one its clients get.
export function jsonResponses({ headers = {}, indent }: { headers?: Record<string, string>; indent?: number } = {}) {
  return (body: unknown, status = 200, contentType = "application/json"): Response =>
    new Response(JSON.stringify(body, null, indent), { status, headers: { ...headers, "Content-Type": contentType } });
}

// Indented, for the cron-run functions whose answers people read.
export const json = jsonResponses({ indent: 2 });

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

type NumberKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

// The sum over `items` of a numeric field, or of what `by` reads from each.
export function sumBy<T>(items: readonly T[], by: NumberKey<T> | ((item: T) => number)): number {
  const value = typeof by === "function" ? by : (item: T) => item[by] as number;
  return items.reduce((sum, item) => sum + value(item), 0);
}
