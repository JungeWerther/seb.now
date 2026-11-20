-- What the crawlers migration touches beyond accounts_shape.sql and the
-- accounts migration: auth.sessions (cut down to the columns it reads) and the
-- signal tables' own row security, which its restrictive policies sit on.
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.link_impressions enable row level security;
create policy "users can record their own impressions" on public.link_impressions
  for insert to authenticated with check (auth.uid() = viewer_id);
alter table public.link_visits enable row level security;
create policy "users can record their own visits" on public.link_visits
  for insert to authenticated with check (auth.uid() = visitor_id);
alter table public.votes enable row level security;
create policy "users can cast their own votes" on public.votes
  for insert to authenticated with check (auth.uid() = voter_id);
