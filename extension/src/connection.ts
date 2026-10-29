// The extension's connection to a seb.now account: the token seb.now/connect
// handed over, whether it may send pages yet, and the Connect that asks for it.
//
// Connect opens seb.now/connect#nonce=<random>; the page asks for a token as
// the browser's own session and posts it to its window; the content script
// (connect.ts) takes it only from that page, only with that nonce, only once,
// and only within NONCE_TTL_MS. The checks are plain functions here.

import { CONFIG } from "./config.ts";

export interface Connection {
  token: string;
  status: "active" | "pending";
  pairCode: string | null;
}

export interface PendingConnect {
  nonce: string;
  at: number;
}

const TOKEN_SHAPE = /^sft_[0-9a-f]{64}$/;
const PAIR_CODE_SHAPE = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;
const STATUSES: readonly Connection["status"][] = ["active", "pending"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// 24 random bytes as base64url: 32 characters, the shape the page accepts.
export function newNonce(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (b) => crypto.getRandomValues(b),
): string {
  const bytes = random(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const connectUrl = (nonce: string): string =>
  `${CONFIG.SEB_NOW_ORIGIN}${CONFIG.CONNECT_PATH}#nonce=${encodeURIComponent(nonce)}`;

// The connection a hand-over message carries, or null when it isn't one this
// extension asked for: wrong origin, no Connect waiting, another nonce, a
// Connect too old, or a token or code of the wrong shape.
export function acceptHandOver(
  origin: string,
  message: unknown,
  pending: PendingConnect | undefined,
  now: number,
): Connection | null {
  if (origin !== CONFIG.SEB_NOW_ORIGIN || !pending || now - pending.at > CONFIG.NONCE_TTL_MS) return null;
  if (!isRecord(message) || message.type !== "seb-follow-token" || message.nonce !== pending.nonce) return null;
  const { token, status, pairCode } = message;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const known = STATUSES.find((s) => s === status);
  if (!known) return null;
  if (known === "pending" && !(typeof pairCode === "string" && PAIR_CODE_SHAPE.test(pairCode))) return null;
  return { token, status: known, pairCode: known === "pending" ? (pairCode as string) : null };
}

export const isPendingConnect = (value: unknown): value is PendingConnect =>
  isRecord(value) && typeof value.nonce === "string" && typeof value.at === "number";

export const isConnection = (value: unknown): value is Connection =>
  isRecord(value) && typeof value.token === "string" && TOKEN_SHAPE.test(value.token) &&
  (value.status === "active" || value.status === "pending");

export async function loadConnection(): Promise<Connection | undefined> {
  const stored = await chrome.storage.local.get(CONFIG.CONNECTION_KEY);
  const connection: unknown = stored[CONFIG.CONNECTION_KEY];
  return isConnection(connection) ? connection : undefined;
}

export const saveConnection = (connection: Connection) =>
  chrome.storage.local.set({ [CONFIG.CONNECTION_KEY]: connection });

export const forgetConnection = () => chrome.storage.local.remove(CONFIG.CONNECTION_KEY);

// Starts a Connect: a fresh nonce kept for the content script, and seb.now/connect opened.
export async function startConnect(): Promise<void> {
  const nonce = newNonce();
  await chrome.storage.local.set({ [CONFIG.NONCE_KEY]: { nonce, at: Date.now() } satisfies PendingConnect });
  await chrome.tabs.create({ url: connectUrl(nonce) });
}
