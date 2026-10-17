-- "New" means new to the reader (SEB-15). The latest order puts the links the
-- reader has already seen below the ones they haven't, each part newest first.
-- A link is seen once the reader has clicked it (link_visits) or had its row on
-- screen (link_impressions, recorded by the page). Seen links are moved down,
-- not left out, so /o/latest still lists every post.
--
-- Only what was seen at or before `as_of` counts: the feed's pages are offsets
-- against a fixed `as_of`, and rows the reader sees while scrolling must not
-- reorder the pages still to come. Back-to-top starts again with a fresh
-- `as_of`, and what was read meanwhile drops below.
--
-- feed_query is security invoker, so RLS scopes both tables to the caller
-- (auth.uid()); a caller with no session has seen nothing.

create table public.link_impressions (
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  link_id uuid not null references public.links(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (viewer_id, link_id)
);

alter table public.link_impressions enable row level security;

create policy "users can read their own impressions"
  on public.link_impressions for select
  to authenticated
  using ((select auth.uid()) = viewer_id);

create policy "users can record their own impressions"
  on public.link_impressions for insert
  to authenticated
  with check ((select auth.uid()) = viewer_id);

revoke all on public.link_impressions from anon;
revoke update, delete, truncate, references, trigger on public.link_impressions from authenticated;
grant select, insert on public.link_impressions to authenticated;

create or replace function public.feed_query(
  sort text,
  topic text,
  search text,
  as_of timestamptz,
  page_offset integer default 0,
  page_size integer default 30,
  entities uuid[] default null,
  required jsonb default null
)
returns table (link_id uuid, rank double precision)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  searching boolean := btrim(coalesce(search, '')) <> '';
  groups jsonb := case when jsonb_typeof(required) = 'array' then required else '[]'::jsonb end;
  viewer uuid := auth.uid();
begin
  if sort not in ('for_you', 'latest', 'top', 'discussed') then
    raise exception 'unknown sort %', sort using errcode = '22023';
  end if;
  return query
  with hits as (
    select h.link_id, h.score from link_search_hits(search) h where searching
  ),
  required_groups as (
    select
      array(select jsonb_array_elements_text(coalesce(g -> 'ids', '[]'))::uuid) as ids,
      array(
        select replace(replace(replace(fold_text(w), '\', '\\'), '%', '\%'), '_', '\_')
        from jsonb_array_elements_text(coalesce(g -> 'words', '[]')) w
        where w <> ''
      ) as words
    from jsonb_array_elements(groups) g
  ),
  matching as (
    select l.id, l.created_at, h.score,
      coalesce(cardinality(entities), 0) > 0 and exists (
        select 1 from link_entities le where le.link_id = l.id and le.entity_id = any(entities)
      ) as mentions
    from links l
    left join hits h on h.link_id = l.id
    where l.created_at <= as_of
      and (topic is null or exists (
        select 1 from link_topics lt where lt.link_id = l.id and lt.topic_id <@ topic::ltree
      ))
      and (not searching or h.link_id is not null)
      and not exists (
        select 1 from required_groups rg
        where not exists (
            select 1 from link_entities le where le.link_id = l.id and le.entity_id = any(rg.ids)
          )
          and (
            cardinality(rg.words) = 0
            or exists (select 1 from unnest(rg.words) w where fold_text(l.search_text) not like '%' || w || '%')
          )
      )
  ),
  scored as (
    select m.id, m.created_at, m.mentions,
      case sort
        when 'for_you' then m.score::double precision
        when 'latest' then extract(epoch from m.created_at)::double precision
        when 'top' then (
          select coalesce(sum(v.value), 0)::double precision from votes v where v.link_id = m.id
        )
        when 'discussed' then (
          select count(*)::double precision from replies r where r.link_id = m.id
        )
      end as rank
    from matching m
    where sort <> 'for_you' or searching
    union all
    select m.id, m.created_at, m.mentions, r.rank
    from matching m
    join ranked_feed(as_of, 0, 2147483647) r on r.link_id = m.id
    where sort = 'for_you' and not searching
  ),
  ordered as (
    select s.*,
      sort = 'latest' and viewer is not null and (
        exists (
          select 1 from link_visits lv
          where lv.link_id = s.id and lv.visitor_id = viewer and lv.visited_at <= as_of
        )
        or exists (
          select 1 from link_impressions li
          where li.viewer_id = viewer and li.link_id = s.id and li.seen_at <= as_of
        )
      ) as seen
    from scored s
  )
  select o.id, o.rank
  from ordered o
  order by o.mentions desc, o.seen, o.rank desc, o.created_at desc, o.id desc
  offset page_offset
  limit page_size;
end
$$;
