-- link_visits: which links a visitor has opened, so the client can grey
-- them out for that visitor. Unlike votes/follows (publicly readable),
-- browsing history is private - select is restricted to the visitor's own
-- rows. No update policy: a visit is recorded once via upsert with
-- ignoreDuplicates, so only insert+select are needed.
create table public.link_visits (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links(id) on delete cascade,
  visitor_id uuid not null references public.profiles(id) on delete cascade,
  visited_at timestamptz not null default now(),
  unique (link_id, visitor_id)
);

alter table public.link_visits enable row level security;

create policy "users can read their own visits"
  on public.link_visits for select
  to authenticated
  using (auth.uid() = visitor_id);

create policy "users can record their own visits"
  on public.link_visits for insert
  to authenticated
  with check (auth.uid() = visitor_id);
