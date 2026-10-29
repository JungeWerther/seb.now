import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { serviceClient, vaultSecret } from "../_shared/clients.ts";
import { FOLLOW_INTAKE } from "../_shared/constants.ts";
import { followIntake } from "../_shared/follow_intake.ts";

// Stages a page sent by the follow browser extension in public.follow_inbox,
// for /follow to pick up (the chain is _shared/follow_intake.ts, the cleaning
// _shared/follow_signals.ts). Deployed with verify_jwt off: the extension has
// no Supabase session, so it authenticates with its own bearer token, the
// Vault secret FOLLOW_INTAKE.TOKEN_SECRET.
//
// POST {"url": "https://…", "title": "…", "feeds": [{"url": "https://…/rss"}],
//       "rel_me": [...], "same_as": [...], "author_urls": [...]}
//   → 200 {"id", "page_url", "status": "pending"}

const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw error;
  return data as T;
};

Deno.serve(followIntake({
  token: () => vaultSecret(FOLLOW_INTAKE.TOKEN_SECRET),
  stage: (pageUrl, signals) => rpc<string>("follow_inbox_put", { page_url: pageUrl, signals }),
  recent: () => rpc<number>("follow_inbox_recent", { since: FOLLOW_INTAKE.RATE_WINDOW }),
}));
