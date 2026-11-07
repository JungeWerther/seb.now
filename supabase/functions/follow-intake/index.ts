import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { serviceClient } from "../_shared/clients.ts";
import { FOLLOW_INTAKE } from "../_shared/constants.ts";
import { followIntake, type TokenHolder } from "../_shared/follow_intake.ts";

// Stages a page sent by the follow browser extension in public.follow_inbox,
// for /follow to pick up (the chain is _shared/follow_intake.ts, the cleaning
// _shared/follow_signals.ts). Deployed with verify_jwt off: the extension holds
// no Supabase session but a token its reader's account was issued through
// seb.now/connect (public.follow_tokens), looked up by follow_token_owner.
//
// POST {"url": "https://…", "title": "…", "feeds": [{"url": "https://…/rss"}],
//       "rel_me": [...], "same_as": [...], "author_urls": [...]}
//   → 200 {"id", "page_url", "status": "pending"}

const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw error;
  return data as T;
};

type HolderRow = { user_id: string; status: TokenHolder["status"]; pair_code: string | null };

Deno.serve(followIntake({
  holder: async (token) => {
    const [row] = await rpc<HolderRow[]>("follow_token_owner", { token });
    return row ? { userId: row.user_id, status: row.status, pairCode: row.pair_code } : null;
  },
  stage: (owner, pageUrl, signals) => rpc<string>("follow_inbox_put", { owner, page_url: pageUrl, signals }),
  recent: (owner) => rpc<number>("follow_inbox_recent", { owner, since: FOLLOW_INTAKE.RATE_WINDOW }),
}));
