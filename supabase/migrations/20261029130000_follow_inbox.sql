-- follow_inbox: pages the follow extension sends from the browser, staged for the
-- /follow skill. The `follow-intake` Edge Function writes here (service_role,
-- after validating and sanitizing what the extension sends); nothing in it is
-- fetched or followed until /follow picks a row up and someone confirms.
--
-- The browser reads pages pg_net can't (Cloudflare, sign-in walls), so this
-- carries what feed discovery needs: the page's own feed links and identity
-- links (rel="me", JSON-LD sameAs), never its body text.
--
-- Additive: one new table and its index, no change to existing data.

create table public.follow_inbox (
  id uuid primary key default gen_random_uuid(),
  page_url text not null
    check (page_url ~ '^https://' and length(page_url) <= 2048),
  signals jsonb not null
    check (jsonb_typeof(signals) = 'object' and pg_column_size(signals) <= 131072),
  status text not null default 'pending'
    check (status in ('pending', 'followed', 'dismissed')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  check ((status = 'pending') = (processed_at is null))
);

comment on table public.follow_inbox is
  'Pages sent by the follow browser extension, staged for /follow. Written by the follow-intake Edge Function only.';

-- Sending the same page twice while it waits refreshes it instead of adding a
-- second row.
create unique index follow_inbox_pending_page on public.follow_inbox (page_url) where status = 'pending';
create index follow_inbox_created on public.follow_inbox (created_at desc);

-- service_role only: no policies, and no grants for the public roles.
alter table public.follow_inbox enable row level security;
revoke all on public.follow_inbox from anon, authenticated;

-- Stages a page, or refreshes the pending row for it. A function rather than a
-- PostgREST upsert, which can't target the partial index above.
create function public.follow_inbox_put(page_url text, signals jsonb)
returns uuid
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.follow_inbox as i (page_url, signals)
  values (follow_inbox_put.page_url, follow_inbox_put.signals)
  on conflict (page_url) where status = 'pending'
  do update set signals = excluded.signals, created_at = now()
  returning i.id
$$;

revoke execute on function public.follow_inbox_put(text, jsonb) from public, anon, authenticated;
grant execute on function public.follow_inbox_put(text, jsonb) to service_role;

-- Pages staged within `since`, for the intake's rate limit.
create function public.follow_inbox_recent(since interval)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$ select count(*) from public.follow_inbox where created_at > now() - since $$;

revoke execute on function public.follow_inbox_recent(interval) from public, anon, authenticated;
grant execute on function public.follow_inbox_recent(interval) to service_role;
