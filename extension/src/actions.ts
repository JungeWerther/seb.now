// The popup's actions as plain functions of their effects, so they are
// tested without a browser (test/actions.test.mjs).

import { CONFIG } from "./config.ts";
import type { Signals } from "./extract.ts";

export interface Outcome {
  ok: boolean;
  message: string;
  // What the intake's answer says about the connection: still good, waiting
  // for approval (with its code), or gone.
  connection?: "active" | "pending" | "gone";
  pairCode?: string;
}

// A new Claude chat with `/follow <page>` typed in.
export function claudeUrl(pageUrl: string): string {
  const url = new URL(CONFIG.CLAUDE_NEW_CHAT_URL);
  url.searchParams.set("q", `${CONFIG.FOLLOW_COMMAND} ${pageUrl}`);
  return url.href;
}

// Pages the extension can read: the web, not the browser's own pages.
export const isWebPage = (url: string | undefined): url is string => /^https?:\/\//i.test(url ?? "");

// What each intake answer means to the reader, by status.
const OUTCOME_BY_STATUS: Readonly<Record<number, Outcome>> = {
  200: { ok: true, message: "Sent to your seb.now inbox.", connection: "active" },
  401: { ok: false, message: "This device was disconnected. Connect again.", connection: "gone" },
  403: { ok: false, message: "Waiting for approval.", connection: "pending" },
  413: { ok: false, message: "This page says too much to send." },
  422: { ok: false, message: "Only public https pages can be followed." },
  429: { ok: false, message: "Too many pages sent this hour. Try again later." },
};

export const outcomeOf = (status: number): Outcome =>
  OUTCOME_BY_STATUS[status] ?? { ok: false, message: `The intake answered ${String(status)}.` };

// The pairing code a 403 names, if any.
async function pairCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    const code = typeof body === "object" && body !== null ? (body as Record<string, unknown>).pair_code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// The page's signals sent to the intake.
export async function sendSignals(
  signals: Signals,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetcher(CONFIG.INTAKE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(signals),
      signal: AbortSignal.timeout(CONFIG.SEND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: "Couldn't reach seb.now. Check your connection." };
  }
  const outcome = outcomeOf(res.status);
  if (res.status !== 403) return outcome;
  const pairCode = await pairCodeOf(res);
  return pairCode ? { ...outcome, message: `Waiting for approval, code ${pairCode}.`, pairCode } : outcome;
}

// `run` wrapped so the reader always sees how it went: `show` gets a busy
// note first, then the outcome, a thrown error included.
export const reported = (show: (outcome: Outcome | "busy") => void) =>
<A extends unknown[]>(run: (...args: A) => Promise<Outcome>) =>
async (...args: A): Promise<Outcome> => {
  show("busy");
  let outcome: Outcome;
  try {
    outcome = await run(...args);
  } catch (error) {
    outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  show(outcome);
  return outcome;
};
