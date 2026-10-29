// Every setting of the extension, in one place.

import type { Limits } from "./extract.ts";

export const CONFIG = Object.freeze({
  // The follow-intake Edge Function of the seb.now Supabase project.
  INTAKE_URL: "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/follow-intake",
  // A new Claude chat, its prompt prefilled from `q`.
  CLAUDE_NEW_CHAT_URL: "https://claude.ai/new",
  // The prompt: the /follow skill and the page.
  FOLLOW_COMMAND: "/follow",
  // seb.now, whose /connect page hands this extension its token.
  SEB_NOW_ORIGIN: "https://seb.now",
  CONNECT_PATH: "/connect",
  // How long a Connect may take before its nonce stops being accepted.
  NONCE_TTL_MS: 10 * 60_000,
  // storage.local keys: the connection (token, status, pairing code) and the
  // nonce of a Connect in progress.
  CONNECTION_KEY: "connection",
  NONCE_KEY: "connectNonce",
  // How long a send may take before the popup gives up on it.
  SEND_TIMEOUT_MS: 10_000,
  // Kept well under the intake's caps, which clean again.
  LIMITS: Object.freeze<Limits>({
    maxItems: 40,
    maxString: 2048,
    maxJsonLdScripts: 20,
    maxJsonLdChars: 200_000,
  }),
});
