// The follow-intake handler: the follow browser extension POSTs a page's
// signals here and they are staged in public.follow_inbox for /follow.
//
// The handler is its steps stacked as wrappers, outermost first, each one a
// `Middleware` that either answers or hands the request on:
//
//   cors → 500 guard → only POST → whose token → their rate limit
//   → body under the cap → JSON → clean the signals → stage them
//
// The bearer token is one a reader's own account was issued through
// seb.now/connect (public.follow_tokens), so every page is staged as theirs.
// Its effects (the token lookup, the store, the count) are injected, so the
// whole chain is tested without a database (follow_intake_test.ts).

import { FOLLOW_INTAKE } from "./constants.ts";
import { type Signals, signals as cleanSignals } from "./follow_signals.ts";

export type Handler = (req: Request) => Promise<Response>;
export type Middleware = (next: Handler) => Handler;

// A handler past authentication: the account the request is from is known.
export type Owned = (req: Request, owner: string) => Promise<Response>;

export interface TokenHolder {
  userId: string;
  status: "pending" | "active" | "revoked";
  pairCode: string | null;
}

export interface IntakeDeps {
  // Whose token this is, or null for one never issued.
  holder: (token: string) => Promise<TokenHolder | null>;
  // Stages a page's signals for `owner`, returning the inbox row's id.
  stage: (owner: string, pageUrl: string, signals: Signals) => Promise<string>;
  // Pages `owner` staged within RATE_WINDOW.
  recent: (owner: string) => Promise<number>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const BEARER = /^Bearer\s+(sft_[0-9a-f]{64})$/;

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

// The account behind the bearer token. A token that doesn't have the issued
// shape is refused before any lookup; a revoked or unknown one is 401; one
// whose account isn't allowed yet is 403 with its pairing code, so the
// extension can say what to approve.
export const authenticated = (holder: IntakeDeps["holder"]) => (next: Owned): Handler => async (req) => {
  const token = req.headers.get("authorization")?.match(BEARER)?.[1];
  const found = token ? await holder(token) : null;
  if (!found || found.status === "revoked") return reply(401, { error: "unauthorized" });
  if (found.status === "pending") {
    return reply(403, { error: "waiting for approval", pair_code: found.pairCode });
  }
  return next(req, found.userId);
};

// The body read once, refused past `maxBytes` (by Content-Length when it is
// sent, and by what actually arrives either way), then handed on as JSON.
export const jsonBody =
  (maxBytes: number, handle: (body: unknown, owner: string) => Promise<Response>): Owned => async (req, owner) => {
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
    return handle(body, owner);
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

// At most `max` pages per account within the window.
export const limited = (recent: IntakeDeps["recent"], max: number) => (next: Owned): Owned => async (req, owner) =>
  (await recent(owner)) >= max ? reply(429, { error: "too many pages staged recently" }) : next(req, owner);

// The whole intake: a page staged, or why not.
export function followIntake(deps: IntakeDeps): Handler {
  const stage = async (body: unknown, owner: string) => {
    const cleaned = cleanSignals(body);
    if (!cleaned) return reply(422, { error: "url must be a public https URL" });
    // The page the reader was on, not its canonical: a page names its own
    // canonical, so that stays a signal.
    const pageUrl = cleaned.url;
    const id = await deps.stage(owner, pageUrl, cleaned);
    return reply(200, { id, page_url: pageUrl, status: "pending" });
  };
  const owned = limited(deps.recent, FOLLOW_INTAKE.MAX_PER_WINDOW)(jsonBody(FOLLOW_INTAKE.MAX_BODY_BYTES, stage));
  return stack(cors, guarded, only("POST"))(authenticated(deps.holder)(owned));
}
