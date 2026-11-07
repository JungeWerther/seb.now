-- The part of production's schema the accounts migration touches, as it is
-- before that migration: every table with a column naming a user (each cut
-- down to that column and its unique keys), the credit functions, the replies
-- policy and the guard helpers. Runs as postgres in a fresh database on
-- Supabase's own Postgres image.
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, is_anonymous boolean not null default false);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create extension if not exists ltree with schema extensions;
set search_path = public, extensions;

create function public.must(ok boolean, message text) returns void language plpgsql set search_path = '' as $$
begin
  if ok is not true then raise exception '%', message; end if;
end;
$$;
create function public.refuse(bad boolean, message text) returns void language sql set search_path = '' as $$
  select public.must(bad is not true, message)
$$;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text unique,
  display_name text
);
alter table public.profiles enable row level security;
create policy "profiles are publicly readable" on public.profiles for select to anon, authenticated using (true);
create policy "users can update their own profile" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create table public.kinds (path ltree primary key, owner_id uuid references auth.users (id));
create table public.entities (id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade);
create table public.links (id uuid primary key default gen_random_uuid(),
  submitted_by uuid references public.profiles (id) on delete cascade);
create table public.votes (id uuid primary key default gen_random_uuid(), link_id uuid not null,
  voter_id uuid references public.profiles (id) on delete cascade, value smallint not null,
  unique (link_id, voter_id));
create table public.follows (id uuid primary key default gen_random_uuid(),
  follower_id uuid references public.profiles (id) on delete cascade,
  followee_id uuid references public.profiles (id) on delete cascade,
  followee_actor_uri text,
  unique (follower_id, followee_id), unique (follower_id, followee_actor_uri));
create table public.link_visits (id uuid primary key default gen_random_uuid(),
  visitor_id uuid references public.profiles (id) on delete cascade);
create table public.topics (id text primary key, proposed_by uuid references public.profiles (id) on delete set null);
create table public.replies (id uuid primary key default gen_random_uuid(), link_id uuid not null,
  author_id uuid references public.profiles (id) on delete cascade, body text not null);
alter table public.replies enable row level security;
create policy "replies are publicly readable" on public.replies for select to anon, authenticated using (true);
create policy "users can post their own replies" on public.replies for insert to authenticated
  with check (auth.uid() = author_id);
create table public.topic_overrides (user_id uuid references auth.users (id) on delete cascade,
  topic_id text, score real not null, primary key (user_id, topic_id));
create table public.topic_proposals (id uuid primary key default gen_random_uuid(),
  proposed_by uuid references public.profiles (id) on delete cascade);
create table public.topic_proposal_endorsements (proposal_id uuid not null,
  user_id uuid references public.profiles (id) on delete cascade, primary key (proposal_id, user_id));
create table public.link_topic_suggestions (link_id uuid, topic_id text,
  suggested_by uuid references public.profiles (id) on delete cascade,
  primary key (link_id, topic_id, suggested_by));
create table public.link_impressions (viewer_id uuid references public.profiles (id) on delete cascade,
  link_id uuid, seen_at timestamptz not null default now(), primary key (viewer_id, link_id));
create table public.notifications (id uuid primary key default gen_random_uuid(),
  recipient_id uuid references public.profiles (id) on delete cascade, reply_id uuid not null);
create unique index notifications_recipient_reply_key on public.notifications (recipient_id, reply_id);
create table public.ap_followers (id uuid primary key default gen_random_uuid(), actor_url text not null,
  profile_id uuid references public.profiles (id) on delete cascade,
  unique nulls not distinct (actor_url, profile_id));
create table public.ap_actor_keys (profile_id uuid primary key references public.profiles (id) on delete cascade);

create table public.query_credits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  used integer not null default 0 check (used >= 0)
);
alter table public.query_credits enable row level security;
create policy "Readers see their own query credits" on public.query_credits for select to authenticated
  using (auth.uid() = user_id);
create function public.query_credit_limit() returns integer language sql immutable set search_path = ''
  as $$ select 1000 $$;
create function public.query_credits_left() returns integer language sql stable set search_path = public as $$
  select query_credit_limit() - coalesce((select used from query_credits where user_id = auth.uid()), 0)
$$;
create function public.spend_query_credit() returns integer language sql volatile security definer
  set search_path = public as $$
  insert into query_credits as c (user_id, used) select auth.uid(), 1 where auth.uid() is not null
  on conflict (user_id) do update set used = c.used + 1 where c.used < query_credit_limit()
  returning query_credit_limit() - used
$$;
create function public.refund_query_credit(target uuid) returns integer language sql volatile security definer
  set search_path = public as $$
  update query_credits set used = greatest(used - 1, 0) where user_id = target returning query_credit_limit() - used
$$;
