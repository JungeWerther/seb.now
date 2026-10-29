// The popup's actions as plain functions of their effects, so they are
// tested without a browser (test/actions.test.mjs).

import { CONFIG } from "./config.ts";
import type { Signals } from "./extract.ts";

export type Outcome = { ok: true; message: string } | { ok: false; message: string };

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
  200: { ok: true, message: "Sent to your seb.now inbox." },
  401: { ok: false, message: "The intake refused the token. Check it in the options." },
  413: { ok: false, message: "This page says too much to send." },
  422: { ok: false, message: "Only public https pages can be followed." },
  429: { ok: false, message: "Too many pages sent this hour. Try again later." },
};

export const outcomeOf = (status: number): Outcome =>
  OUTCOME_BY_STATUS[status] ?? { ok: false, message: `The intake answered ${String(status)}.` };

// The page's signals sent to the intake.
export async function sendSignals(
  signals: Signals,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const res = await fetcher(CONFIG.INTAKE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(signals),
      signal: AbortSignal.timeout(CONFIG.SEND_TIMEOUT_MS),
    });
    return outcomeOf(res.status);
  } catch {
    return { ok: false, message: "Couldn't reach seb.now. Check your connection." };
  }
}

// Whether `token` is the intake's: an empty page is refused for its url (422)
// only after the token passed, so nothing is staged.
export async function checkToken(token: string, fetcher: typeof fetch = fetch): Promise<Outcome> {
  try {
    const res = await fetcher(CONFIG.INTAKE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(CONFIG.SEND_TIMEOUT_MS),
    });
    return res.status === 422 ? { ok: true, message: "Token works." } : outcomeOf(res.status);
  } catch {
    return { ok: false, message: "Couldn't reach seb.now. Check your connection." };
  }
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
