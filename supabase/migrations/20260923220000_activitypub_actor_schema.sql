-- get_vault_secret: lets the activitypub edge function (service_role) read the
-- actor's RSA keypair (stored in Vault, not this table) without a direct
-- `vault` schema grant. Mirrors the same helper in the personal-CRM project's
-- `do-api` function. Only postgres/service_role may execute it - never anon
-- or authenticated, since it can read any named secret.
create function public.get_vault_secret(secret_name text)
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name limit 1;
$$;

revoke execute on function public.get_vault_secret(text) from public, anon, authenticated;

-- ap_followers: remote ActivityPub actors following the site's single actor
-- (@seb@seb.now), populated by the activitypub edge function's inbox handler
-- on a verified Follow activity and removed on Undo. Distinct from
-- public.follows (a local profile following someone/something) - this is
-- the opposite direction, has no local profile on either side, and is
-- written only by the edge function via service_role, so RLS is enabled
-- with no policies (no anon/authenticated access at all).
create table public.ap_followers (
  id uuid primary key default gen_random_uuid(),
  actor_url text not null unique,
  inbox_url text not null,
  shared_inbox_url text,
  created_at timestamptz not null default now()
);

alter table public.ap_followers enable row level security;
