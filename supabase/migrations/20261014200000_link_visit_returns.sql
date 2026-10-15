-- A visit is now one row per click, with how the reader came back: how long
-- they were away (`away_ms`, measured on their own clock from the click, or
-- from the page being hidden for a link opened in a new tab), how
-- (`return_kind`), and the first thing they did after (`next_action`, with
-- `next_link_id` when it concerned a link). A visit with no `away_ms` never
-- came back, or came back after more than a day, which the page doesn't
-- record. Still private to the visitor.
--
-- return_kind: `tab` (the link opened in a new tab, as article links do,
-- and this tab became visible again), `app` (the page stayed but was hidden
-- after a same-tab click, e.g. the link opened in another app), `back` (Back
-- to the page restored from the back/forward cache, or reloaded by it),
-- `reload`, `other` (the page loaded again any other way within the same tab
-- session).
alter table public.link_visits drop constraint link_visits_link_id_visitor_id_key;

alter table public.link_visits
  add column away_ms integer check (away_ms between 0 and 86400000),
  add column return_kind text check (return_kind in ('back', 'tab', 'app', 'reload', 'other')),
  add column next_action text check (next_action in ('visit', 'open', 'upvote', 'downvote', 'reply', 'left')),
  add column next_link_id uuid references public.links (id) on delete set null,
  add constraint link_visits_return_complete check ((away_ms is null) = (return_kind is null)),
  add constraint link_visits_next_after_return check (next_action is null or away_ms is not null);

create index link_visits_visitor_link_idx on public.link_visits (visitor_id, link_id);

create policy "users can complete their own visits"
  on public.link_visits for update
  to authenticated
  using (auth.uid() = visitor_id)
  with check (auth.uid() = visitor_id);
