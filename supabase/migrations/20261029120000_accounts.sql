-- Accounts: an anonymous session can become a real one (an email attached to
-- the same auth user, so nothing moves), and a real account unlocks features.
--
--   is_permanent(user)     -- the user has signed in with an email (auth.users
--                             is the source of truth, not a JWT that can lag)
--   account_consents       -- which privacy-policy version a user accepted, when
--   style_picks            -- Appearance picks, synced across a real account's devices
--   query_credit_limit(u)  -- 1,000 anonymous, 10,000 for a real account
--   replies                -- posting needs a real account (reading stays public)
--   profiles.handle        -- setting one needs a real account; existing ones stay
--   merge_account(from, into) + account_columns
--                          -- folds an anonymous account into a real one, driven
--                             by a table of every column that names a user, and
--                             refusing to run while a referencing column is missing
--                             from it, so a new table can't be silently left behind
--
-- Nothing is deleted or rewritten by this migration itself.

-- ── who is a real account ────────────────────────────────────────────────────

create function public.is_permanent(account uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select not u.is_anonymous from auth.users u where u.id = account), false)
$$;

revoke execute on function public.is_permanent(uuid) from public;
grant execute on function public.is_permanent(uuid) to anon, authenticated, service_role;

-- ── consents ─────────────────────────────────────────────────────────────────

create table public.account_consents (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  policy_version text not null check (policy_version ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at timestamptz not null default now(),
  primary key (user_id, policy_version)
);

alter table public.account_consents enable row level security;

create policy "Readers see their own consents"
  on public.account_consents for select to authenticated
  using (auth.uid() = user_id);

create policy "Readers record their own consents"
  on public.account_consents for insert to authenticated
  with check (auth.uid() = user_id);

revoke all on public.account_consents from anon, authenticated;
grant select on public.account_consents to authenticated;
grant insert (user_id, policy_version) on public.account_consents to authenticated;

-- ── Appearance picks follow a real account ───────────────────────────────────

create table public.style_picks (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  type_path extensions.ltree not null references public.kinds (path) on delete cascade,
  style_id uuid not null references public.entities (id) on delete cascade,
  picked_at timestamptz not null default now(),
  primary key (user_id, type_path)
);

alter table public.style_picks enable row level security;

create policy "Readers see their own picks"
  on public.style_picks for select to authenticated
  using (auth.uid() = user_id);

create policy "Accounts pick their own styles"
  on public.style_picks for insert to authenticated
  with check (auth.uid() = user_id and (select public.is_permanent()));

create policy "Accounts change their own picks"
  on public.style_picks for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and (select public.is_permanent()));

create policy "Readers drop their own picks"
  on public.style_picks for delete to authenticated
  using (auth.uid() = user_id);

revoke all on public.style_picks from anon, authenticated;
grant select, delete on public.style_picks to authenticated;
grant insert (user_id, type_path, style_id), update (style_id, picked_at)
  on public.style_picks to authenticated;

-- ── credits by tier ──────────────────────────────────────────────────────────

create function public.query_credit_limit_anonymous() returns integer
language sql immutable set search_path = '' as $$ select 1000 $$;

create function public.query_credit_limit_account() returns integer
language sql immutable set search_path = '' as $$ select 10000 $$;

-- Replaces the zero-argument version; callers writing `query_credit_limit()`
-- now get the caller's own limit through the default.
drop function public.query_credit_limit();

create function public.query_credit_limit(account uuid default auth.uid())
returns integer
language sql
stable
set search_path = ''
as $$
  select case when public.is_permanent(account)
    then public.query_credit_limit_account()
    else public.query_credit_limit_anonymous()
  end
$$;

create or replace function public.query_credits_left()
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select query_credit_limit() - coalesce((select used from query_credits where user_id = auth.uid()), 0)
$$;

create or replace function public.spend_query_credit()
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into query_credits as c (user_id, used)
  select auth.uid(), 1
  where auth.uid() is not null
  on conflict (user_id) do update set used = c.used + 1
    where c.used < query_credit_limit(c.user_id)
  returning query_credit_limit(user_id) - used
$$;

-- service_role has no auth.uid(), so the limit is the refunded user's.
create or replace function public.refund_query_credit(target uuid)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  update query_credits
  set used = greatest(used - 1, 0)
  where user_id = target
  returning query_credit_limit(target) - used
$$;

-- ── replies need a real account ──────────────────────────────────────────────

drop policy "users can post their own replies" on public.replies;

create policy "accounts can post their own replies"
  on public.replies for insert to authenticated
  with check (auth.uid() = author_id and (select public.is_permanent()));

-- ── handles need a real account (existing ones stay) ─────────────────────────

-- Setting or changing a handle is refused for an anonymous profile; clearing
-- one is allowed, and a handle already set is left alone.
create function public.profiles_handle_needs_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.refuse(
    new.handle is not null and not public.is_permanent(new.id),
    'a handle needs a signed-in account'
  );
  return new;
end;
$$;

create trigger profiles_handle_needs_account
  before update of handle on public.profiles
  for each row
  when (new.handle is distinct from old.handle)
  execute function public.profiles_handle_needs_account();

-- ── merging an anonymous account into a real one ─────────────────────────────

-- Every column that names a user, and how a merge treats it:
--   move    repoint the rows; where the real account already has a row with
--           the same `conflict_keys` (one comma-separated group per unique key)
--           its row wins and the anonymous one goes
--   drop    the anonymous account's rows go (they can't be repointed: a
--           federated actor's keys and followers are tied to its own id)
--   custom  handled by name in merge_account
create table public.account_columns (
  tbl regclass not null,
  col name not null,
  strategy text not null check (strategy in ('move', 'drop', 'custom')),
  conflict_keys text[] not null default '{}',
  primary key (tbl, col)
);

alter table public.account_columns enable row level security;
revoke all on public.account_columns from anon, authenticated;

insert into public.account_columns (tbl, col, strategy, conflict_keys) values
  ('public.links', 'submitted_by', 'move', '{}'),
  ('public.votes', 'voter_id', 'move', '{link_id}'),
  ('public.follows', 'follower_id', 'move', '{followee_id,followee_actor_uri}'),
  ('public.follows', 'followee_id', 'move', '{follower_id}'),
  ('public.link_visits', 'visitor_id', 'move', '{}'),
  ('public.topics', 'proposed_by', 'move', '{}'),
  ('public.replies', 'author_id', 'move', '{}'),
  ('public.topic_overrides', 'user_id', 'move', '{topic_id}'),
  ('public.topic_proposals', 'proposed_by', 'move', '{}'),
  ('public.topic_proposal_endorsements', 'user_id', 'move', '{proposal_id}'),
  ('public.link_topic_suggestions', 'suggested_by', 'move', '{"link_id,topic_id"}'),
  ('public.entities', 'owner_id', 'move', '{}'),
  ('public.kinds', 'owner_id', 'move', '{}'),
  ('public.link_impressions', 'viewer_id', 'move', '{link_id}'),
  ('public.notifications', 'recipient_id', 'move', '{reply_id}'),
  ('public.account_consents', 'user_id', 'move', '{policy_version}'),
  ('public.style_picks', 'user_id', 'move', '{type_path}'),
  ('public.ap_followers', 'profile_id', 'drop', '{}'),
  ('public.ap_actor_keys', 'profile_id', 'drop', '{}'),
  ('public.query_credits', 'user_id', 'custom', '{}'),
  ('public.profiles', 'id', 'custom', '{}');

-- Columns in public that reference a user (auth.users or profiles) and that
-- account_columns doesn't cover. Must be empty for a merge to run.
create view public.account_columns_missing
with (security_invoker = true)
as
select c.conrelid::regclass as tbl, a.attname as col
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
where c.contype = 'f'
  and c.connamespace = 'public'::regnamespace
  and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
  and not exists (
    select from public.account_columns ac where ac.tbl = c.conrelid and ac.col = a.attname
  );

revoke all on public.account_columns_missing from anon, authenticated;

-- One `move` row: the anonymous rows the real account has no conflicting row
-- for are repointed, the rest are deleted with the anonymous account.
create function public.move_account_rows(target public.account_columns, from_user uuid, into_user uuid)
returns void
language plpgsql
-- extensions, for the equality operators of key columns such as ltree's
set search_path = extensions
as $$
declare
  clash text := (
    select coalesce(string_agg(format('exists (select from %s o where o.%I = $2 and %s)',
      target.tbl, target.col,
      (select string_agg(format('o.%1$I is not distinct from t.%1$I', k), ' and ')
       from unnest(string_to_array(grp, ',')) k)), ' or '), 'false')
    from unnest(target.conflict_keys) grp
  );
begin
  execute format('update %s t set %I = $2 where t.%I = $1 and not (%s)',
    target.tbl, target.col, target.col, clash)
  using from_user, into_user;
  execute format('delete from %s where %I = $1', target.tbl, target.col) using from_user;
end;
$$;

create function public.drop_account_rows(target public.account_columns, from_user uuid, into_user uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('delete from %s where %I = $1', target.tbl, target.col) using from_user;
end;
$$;

-- Folds `from_user` (anonymous) into `into_user` (a real account) and deletes
-- `from_user`. One transaction; refuses rather than half-merges.
create function public.merge_account(from_user uuid, into_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  anon_handle text;
  anon_display_name text;
begin
  perform public.refuse(from_user = into_user, 'cannot merge an account into itself');
  perform public.must(
    exists (select from auth.users where id = from_user and is_anonymous),
    'only an anonymous account can be merged away');
  perform public.must(public.is_permanent(into_user), 'can only merge into a signed-in account');
  perform public.refuse(
    exists (select from public.account_columns_missing),
    'account_columns is missing a column that references a user');

  -- Same lock order for any pair, so two merges sharing an account serialize.
  perform pg_advisory_xact_lock(hashtextextended(least(from_user, into_user)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(from_user, into_user)::text, 0));

  perform case ac.strategy
      when 'move' then public.move_account_rows(ac, from_user, into_user)
      when 'drop' then public.drop_account_rows(ac, from_user, into_user)
    end
  from public.account_columns ac
  where ac.strategy in ('move', 'drop');

  -- Leftovers a move can create: following yourself, endorsing your own proposal.
  delete from public.follows where follower_id = into_user and followee_id = into_user;
  delete from public.topic_proposal_endorsements e
  using public.topic_proposals p
  where e.proposal_id = p.id and e.user_id = into_user and p.proposed_by = into_user;

  -- Credits used add up.
  insert into public.query_credits as c (user_id, used)
  select into_user, used from public.query_credits where user_id = from_user
  on conflict (user_id) do update set used = c.used + excluded.used;
  delete from public.query_credits where user_id = from_user;

  -- The profile: the real account keeps its own fields, filling empty ones.
  select handle, display_name into anon_handle, anon_display_name
  from public.profiles where id = from_user;
  update public.profiles set handle = null where id = from_user;
  update public.profiles
  set handle = coalesce(handle, anon_handle),
      display_name = coalesce(display_name, anon_display_name)
  where id = into_user;

  delete from auth.users where id = from_user;
end;
$$;

revoke execute on function public.merge_account(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.move_account_rows(public.account_columns, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.drop_account_rows(public.account_columns, uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_account(uuid, uuid) to service_role;
