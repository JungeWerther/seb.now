// The follow-intake handler: the follow browser extension POSTs a page's
// signals here and they are staged in public.follow_inbox for /follow.
//
// The handler is its steps stacked as wrappers, outermost first, each one a
// `Middleware` that either answers or hands the request on:
//
//   cors → only POST → bearer token → body under the cap → JSON → rate limit
//   → clean the signals → stage them
//
// Its effects (the token, the store, the count) are injected, so the whole
// chain is tested without a database (follow_intake_test.ts).

import { FOLLOW_INTAKE } from "./constants.ts";
import { type Signals, signals as cleanSignals } from "./follow_signals.ts";

export type Handler = (req: Request) => Promise<Response>;
export type Middleware = (next: Handler) => Handler;

export interface IntakeDeps {
  // The extension's bearer token.
  token: () => Promise<string>;
  // Stages a page's signals, returning the inbox row's id.
  stage: (pageUrl: string, signals: Signals) => Promise<string>;
  // Pages staged within RATE_WINDOW.
  recent: () => Promise<number>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const BEARER = /^Bearer\s+(\S+)$/i;

export const reply = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// `middlewares` around `handler`, the first one outermost.
export const stack = (...middlewares: Middleware[]) => (handler: Handler): Handler =>
  middlewares.reduceRight((next, middleware) => middleware(next), handler);

// Preflights answered, and every answer carrying the CORS headers (the
// extension's pages are their own origin). The token is a bearer header, never
// a cookie, so any origin may ask.
export const cors: Middleware = (next) => async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const res = await next(req);
  for (const [name, value] of Object.entries(CORS)) res.headers.set(name, value);
  return res;
};

export const only = (method: string): Middleware => (next) => (req) =>
  req.method === method ? next(req) : Promise.resolve(reply(405, { error: `use ${method}` }));

// Equal strings, compared by their SHA-256 digests so the time taken says
// nothing about how much of a guess was right.
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0) === 0;
}

export const bearer = (token: () => Promise<string>): Middleware => (next) => async (req) => {
  const given = req.headers.get("authorization")?.match(BEARER)?.[1];
  if (!given || !(await sameSecret(given, await token()))) return reply(401, { error: "unauthorized" });
  return next(req);
};

// The body read once, refused past `maxBytes` (by Content-Length when it is
// sent, and by what actually arrives either way), then handed on as JSON.
export const jsonBody = (maxBytes: number, handle: (body: unknown) => Promise<Response>): Handler => async (req) => {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return reply(413, { error: "too large" });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > maxBytes) return reply(413, { error: "too large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return reply(400, { error: "not JSON" });
  }
  return handle(body);
};

// A failure past this point answers 500 without its message, which could
// carry database detail.
export const guarded: Middleware = (next) => async (req) => {
  try {
    return await next(req);
  } catch (error) {
    console.error("follow-intake", error);
    return reply(500, { error: "could not stage the page" });
  }
};

export const limited = (recent: () => Promise<number>, max: number): Middleware => (next) => async (req) =>
  (await recent()) >= max ? reply(429, { error: "too many pages staged recently" }) : next(req);

// The whole intake: a page staged, or why not.
export function followIntake(deps: IntakeDeps): Handler {
  const stage = async (body: unknown) => {
    const cleaned = cleanSignals(body);
    if (!cleaned) return reply(422, { error: "url must be a public https URL" });
    // The page the reader was on, not its canonical: a page names its own
    // canonical, so that stays a signal.
    const pageUrl = cleaned.url;
    const id = await deps.stage(pageUrl, cleaned);
    return reply(200, { id, page_url: pageUrl, status: "pending" });
  };
  return stack(
    cors,
    guarded,
    only("POST"),
    bearer(deps.token),
    limited(deps.recent, FOLLOW_INTAKE.MAX_PER_WINDOW),
  )(jsonBody(FOLLOW_INTAKE.MAX_BODY_BYTES, stage));
}
