-- topic_overrides: a user's own score for a topic, set by dragging its slider
-- in My Algorithm. It replaces the vote-derived score in ranked_feed; deleting
-- the row resets the topic to its default. Private to its owner, unlike votes.
create table public.topic_overrides (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  topic_id extensions.ltree not null references public.topics (id) on delete cascade,
  score double precision not null check (score >= 0 and score <= 1),
  updated_at timestamptz not null default now(),
  primary key (user_id, topic_id)
);

alter table public.topic_overrides enable row level security;

create policy "Users read their own topic overrides" on public.topic_overrides
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own topic overrides" on public.topic_overrides
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own topic overrides" on public.topic_overrides
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users remove their own topic overrides" on public.topic_overrides
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.topic_overrides to authenticated;

-- ranked_feed: a topic's score is now the caller's override when they have
-- one, else the vote-derived Beta mean.
create or replace function public.ranked_feed(as_of timestamptz, page_offset integer, page_size integer)
returns table (link_id uuid, rank double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with overrides as (
    select topic_id, score
    from public.topic_overrides
    where user_id = auth.uid()
  ),
  mine as (
    select topic_id, score from overrides
    union all
    select p.topic_id, p.alpha / (p.alpha + p.beta)
    from public.user_topic_preferences p
    where p.voter_id = auth.uid()
      and not exists (select 1 from overrides o where o.topic_id operator(extensions.=) p.topic_id)
  ),
  link_taste as (
    select
      lt.link_id,
      sum(lt.p * coalesce(own.score, parent.score, 0.5)) / sum(lt.p) as taste
    from public.link_topics lt
    left join mine own on own.topic_id operator(extensions.=) lt.topic_id
    left join mine parent
      on extensions.nlevel(lt.topic_id) > 1
     and parent.topic_id operator(extensions.=) extensions.subpath(lt.topic_id, 0, extensions.nlevel(lt.topic_id) - 1)
    group by lt.link_id
  ),
  link_votes as (
    select
      link_id,
      count(*) filter (where value = 1) as ups,
      count(*) filter (where value = -1) as downs
    from public.votes
    group by link_id
  )
  select
    l.id,
    coalesce(t.taste, 0.5)
      * (1 + coalesce(v.ups, 0))::double precision / (2 + coalesce(v.ups, 0) + coalesce(v.downs, 0))
      * power(0.5, extract(epoch from as_of - l.created_at) / 3600 / 24) as rank
  from public.links l
  left join link_taste t on t.link_id = l.id
  left join link_votes v on v.link_id = l.id
  where l.created_at <= as_of
  order by rank desc, l.id desc
  offset page_offset
  limit page_size
$$;
