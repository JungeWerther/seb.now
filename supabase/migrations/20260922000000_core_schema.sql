-- profiles: one row per auth user (including anonymous sessions), the public curator identity
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are publicly readable"
  on public.profiles for select
  to anon, authenticated
  using (true);

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- auto-create a blank profile the moment an auth user (incl. anonymous) exists
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- only the trigger needs to invoke this; it must not be callable as a public RPC
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- links: curated links, either submitted locally or ingested from a followed fediverse actor.
-- submitted_by is nullable to allow unattributed/seed content.
create table public.links (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid references public.profiles(id) on delete cascade,
  url text not null,
  title text not null,
  description text,
  origin text not null default 'local' check (origin in ('local', 'fediverse')),
  fediverse_post_uri text,
  created_at timestamptz not null default now()
);

alter table public.links enable row level security;

create policy "links are publicly readable"
  on public.links for select
  to anon, authenticated
  using (true);

create policy "users can submit their own links"
  on public.links for insert
  to authenticated
  with check (auth.uid() = submitted_by);

create policy "users can delete their own links"
  on public.links for delete
  to authenticated
  using (auth.uid() = submitted_by);

-- votes: one vote per (link, voter), upsertable via the unique constraint
create table public.votes (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  unique (link_id, voter_id)
);

alter table public.votes enable row level security;

create policy "votes are publicly readable"
  on public.votes for select
  to anon, authenticated
  using (true);

create policy "users can cast their own votes"
  on public.votes for insert
  to authenticated
  with check (auth.uid() = voter_id);

create policy "users can change their own votes"
  on public.votes for update
  to authenticated
  using (auth.uid() = voter_id)
  with check (auth.uid() = voter_id);

create policy "users can remove their own votes"
  on public.votes for delete
  to authenticated
  using (auth.uid() = voter_id);

-- follows: follower -> a local profile OR a remote fediverse actor URI, never both/neither
create table public.follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid references public.profiles(id) on delete cascade,
  followee_actor_uri text,
  created_at timestamptz not null default now(),
  constraint follows_exactly_one_target check (
    (followee_id is not null and followee_actor_uri is null)
    or (followee_id is null and followee_actor_uri is not null)
  ),
  unique (follower_id, followee_id),
  unique (follower_id, followee_actor_uri)
);

alter table public.follows enable row level security;

create policy "follows are publicly readable"
  on public.follows for select
  to anon, authenticated
  using (true);

create policy "users manage their own follows insert"
  on public.follows for insert
  to authenticated
  with check (auth.uid() = follower_id);

create policy "users manage their own follows delete"
  on public.follows for delete
  to authenticated
  using (auth.uid() = follower_id);
