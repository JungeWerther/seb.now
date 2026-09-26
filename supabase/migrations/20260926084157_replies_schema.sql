-- replies: plain-text replies to a link, written from the page by any
-- signed-in (including anonymous) user. Bodies are stored exactly as typed
-- and must only ever be rendered as text (textContent / html.escape), never
-- as HTML - that output encoding is what makes them XSS-safe, not any
-- input-side HTML stripping. The checks below only bound size and reject
-- control characters (newlines and tabs allowed).
create table public.replies (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint replies_body_length check (char_length(btrim(body)) between 1 and 500),
  constraint replies_body_no_control_chars check (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
);

create index replies_link_id_created_at_idx on public.replies (link_id, created_at);

alter table public.replies enable row level security;

create policy "replies are publicly readable"
  on public.replies for select
  to anon, authenticated
  using (true);

create policy "users can post their own replies"
  on public.replies for insert
  to authenticated
  with check (auth.uid() = author_id);

create policy "users can delete their own replies"
  on public.replies for delete
  to authenticated
  using (auth.uid() = author_id);
