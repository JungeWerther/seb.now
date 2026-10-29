// Every setting of the extension, in one place.

import type { Limits } from "./extract.ts";

export const CONFIG = Object.freeze({
  // The follow-intake Edge Function of the seb.now Supabase project.
  INTAKE_URL: "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/follow-intake",
  // A new Claude chat, its prompt prefilled from `q`.
  CLAUDE_NEW_CHAT_URL: "https://claude.ai/new",
  // The prompt: the /follow skill and the page.
  FOLLOW_COMMAND: "/follow",
  // storage.local key of the intake's bearer token.
  TOKEN_KEY: "intakeToken",
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
