// The service_role client and the Vault secrets read through it, each made
// once per isolate.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { lazy, memoize } from "./memo.ts";
import { ENV, VAULT } from "./constants.ts";

export const serviceClient: () => SupabaseClient = lazy(() => createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY));

// The secret named `name` (get_vault_secret, service_role only); a missing one
// rejects and is asked again next time.
export const vaultSecret = memoize((name: string) => name, async (name: string): Promise<string> => {
  const { data, error } = await serviceClient().rpc("get_vault_secret", { secret_name: name });
  if (error || !data) throw new Error(`no ${name} in Vault`);
  return data as string;
}, { maxEntries: VAULT.CACHED_SECRETS });
