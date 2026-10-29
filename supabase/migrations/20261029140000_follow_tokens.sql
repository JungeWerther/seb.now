-- Follow tokens: the browser extension connects to an account instead of
-- carrying a shared secret. seb.now/connect, open in the reader's browser,
-- asks for a token for its own session (anonymous or real) and hands it to the
-- extension; the follow-intake function then knows whose page it is.
--
--   follow_curators       -- accounts allowed to send pages ("known users");
--                            a real (email) account is allowed without a row
--   follow_tokens         -- one per connected device: only the token's
--                            SHA-256 is kept, so a database read can't replay it;
--                            pending until its account is allowed, revocable
--   follow_inbox.owner_id -- the account a page was sent by; each has its own
--                            pending pages and rate limit
--
-- A token for an account that isn't allowed yet waits with a short pairing
-- code (K7Q-2MX); approving the code allows the account and every one of its
-- pending tokens:  select public.approve_follow_token('K7Q-2MX');
--
-- Data: follow_inbox gains a non-null owner_id, so this refuses to apply if it
-- holds rows (it can't yet: follow-intake was never deployed with a token).
-- Nothing else changes; the new tables start empty.

-- ── who may send pages ───────────────────────────────────────────────────────

-- `scope` is fixed: it gives the row a key that a merge can compare (see
-- account_columns below), so folding one allowed account into another keeps one row.
create table public.follow_curators (
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null default 'follow' check (scope = 'follow'),
  added_at timestamptz not null default now(),
  primary key (user_id, scope)
);

comment on table public.follow_curators is
  'Accounts allowed to send pages from the follow extension. Real accounts are allowed without a row.';

alter table public.follow_curators enable row level security;
revoke all on public.follow_curators from anon, authenticated;

create function public.may_follow(account uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_permanent(account)
      or exists (select from public.follow_curators where user_id = account)
$$;

revoke execute on function public.may_follow(uuid) from public, anon, authenticated;
grant execute on function public.may_follow(uuid) to service_role;

-- ── tokens ───────────────────────────────────────────────────────────────────

create table public.follow_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash bytea not null unique check (length(token_hash) = 32),
  label text not null check (length(label) between 1 and 80),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  -- Shown while pending, so the token can be approved without being seen.
  pair_code text check (pair_code ~ '^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$'),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  check ((status = 'pending') = (pair_code is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index follow_tokens_pending_code on public.follow_tokens (pair_code) where status = 'pending';
create index follow_tokens_user on public.follow_tokens (user_id);

comment on table public.follow_tokens is
  'Follow extension tokens, one per connected device. Only the SHA-256 of each token is stored.';

alter table public.follow_tokens enable row level security;
revoke all on public.follow_tokens from anon, authenticated;

-- A pairing code: six characters that can't be misread (no 0/O, 1/I/L).
create function public.follow_pair_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(
           substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 31), 1)
           || case when i = 2 then '-' else '' end, '' order by i)
  from (select uuid_send(gen_random_uuid()) as b) r, generate_series(0, 5) i
$$;

-- For the caller's own session: a new token, active at once when the account
-- may send pages, else pending with a pairing code. The token itself is
-- returned only here, once. 244 random bits: two random UUIDs, minus their
-- fixed version and variant bits.
create function public.request_follow_token(label text)
returns table (token_id uuid, token text, status text, pair_code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  secret text := 'sft_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  allowed boolean;
  code text;
begin
  perform public.must(caller is not null, 'sign in first');
  perform public.refuse(
    (select count(*) from public.follow_tokens t where t.user_id = caller and t.status = 'pending') >= 5,
    'too many devices waiting for approval');
  allowed := public.may_follow(caller);
  if not allowed then
    loop
      code := public.follow_pair_code();
      exit when not exists (select from public.follow_tokens t where t.pair_code = code and t.status = 'pending');
    end loop;
  end if;
  return query
  insert into public.follow_tokens as t (user_id, token_hash, label, status, pair_code, approved_at)
  values (
    caller,
    sha256(convert_to(secret, 'UTF8')),
    left(coalesce(nullif(btrim(request_follow_token.label), ''), 'Browser'), 80),
    case when allowed then 'active' else 'pending' end,
    code,
    case when allowed then now() end)
  returning t.id, secret, t.status, t.pair_code;
end;
$$;

-- The caller's own devices, newest first (never the hashes).
create function public.my_follow_tokens()
returns table (token_id uuid, label text, status text, pair_code text, created_at timestamptz, last_used_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.label, t.status, t.pair_code, t.created_at, t.last_used_at
  from public.follow_tokens t
  where t.user_id = auth.uid() and t.status <> 'revoked'
  order by t.created_at desc
$$;

create function public.revoke_follow_token(token_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with revoked as (
    update public.follow_tokens t
    set status = 'revoked', revoked_at = now(), pair_code = null
    where t.id = revoke_follow_token.token_id and t.user_id = auth.uid() and t.status <> 'revoked'
    returning 1
  )
  select exists (select from revoked)
$$;

revoke execute on function public.follow_pair_code() from public, anon, authenticated;
revoke execute on function public.request_follow_token(text) from public, anon;
revoke execute on function public.my_follow_tokens() from public, anon;
revoke execute on function public.revoke_follow_token(uuid) from public, anon;
grant execute on function public.request_follow_token(text) to authenticated;
grant execute on function public.my_follow_tokens() to authenticated;
grant execute on function public.revoke_follow_token(uuid) to authenticated;

-- ── service_role: approving, and the intake's check ──────────────────────────

-- Allows the account behind a pending pairing code (dash and case optional)
-- and activates all of its pending tokens. Returns the account, or nothing
-- when no token waits with that code.
create function public.approve_follow_token(code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized text := upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'));
  account uuid;
begin
  select t.user_id into account
  from public.follow_tokens t
  where t.status = 'pending' and replace(t.pair_code, '-', '') = normalized;
  if account is null then return null; end if;
  insert into public.follow_curators (user_id) values (account) on conflict do nothing;
  update public.follow_tokens t
  set status = 'active', approved_at = now(), pair_code = null
  where t.user_id = account and t.status = 'pending';
  return account;
end;
$$;

-- Who holds `token`: its account and status, its last use recorded when it is
-- active. No row for a token that was never issued.
create function public.follow_token_owner(token text)
returns table (user_id uuid, status text, pair_code text)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.follow_tokens t
  set last_used_at = case when t.status = 'active' then now() else t.last_used_at end
  where t.token_hash = sha256(convert_to(follow_token_owner.token, 'UTF8'))
  returning t.user_id, t.status, t.pair_code
$$;

revoke execute on function public.approve_follow_token(text) from public, anon, authenticated;
revoke execute on function public.follow_token_owner(text) from public, anon, authenticated;
grant execute on function public.approve_follow_token(text) to service_role;
grant execute on function public.follow_token_owner(text) to service_role;

-- ── the inbox, per account ───────────────────────────────────────────────────

alter table public.follow_inbox
  add column owner_id uuid not null references auth.users (id) on delete cascade;

drop index public.follow_inbox_pending_page;
create unique index follow_inbox_pending_page on public.follow_inbox (owner_id, page_url) where status = 'pending';

drop function public.follow_inbox_put(text, jsonb);
drop function public.follow_inbox_recent(interval);

create function public.follow_inbox_put(owner uuid, page_url text, signals jsonb)
returns uuid
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.follow_inbox as i (owner_id, page_url, signals)
  values (follow_inbox_put.owner, follow_inbox_put.page_url, follow_inbox_put.signals)
  on conflict (owner_id, page_url) where status = 'pending'
  do update set signals = excluded.signals, created_at = now()
  returning i.id
$$;

-- Pages `owner` staged within `since`, for the intake's rate limit.
create function public.follow_inbox_recent(owner uuid, since interval)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*) from public.follow_inbox
  where owner_id = follow_inbox_recent.owner and created_at > now() - since
$$;

revoke execute on function public.follow_inbox_put(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.follow_inbox_recent(uuid, interval) from public, anon, authenticated;
grant execute on function public.follow_inbox_put(uuid, text, jsonb) to service_role;
grant execute on function public.follow_inbox_recent(uuid, interval) to service_role;

-- ── merging accounts (20261029120000_accounts.sql) ───────────────────────────

-- An anonymous account folded into a real one brings its devices, its pages
-- and its standing; where both were allowed, one row stays.
insert into public.account_columns (tbl, col, strategy, conflict_keys) values
  ('public.follow_curators', 'user_id', 'move', '{scope}'),
  ('public.follow_tokens', 'user_id', 'move', '{}'),
  ('public.follow_inbox', 'owner_id', 'move', '{page_url}');
