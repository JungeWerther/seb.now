-- The site's search gets #63's matcher. 20261015221000_feed_query_fulltext.sql
-- redefined the 6-argument feed_query, which no longer existed by then (#64
-- had added `entities`, #73 then `required`), so it was applied without that
-- part; this gives the current feed_query the same change instead:
--   * with search words, only link_search_hits(search)'s links match (full
--     text on links.fts, an entity whose name is the whole query, or every
--     word as a substring, the old rule, so nothing that matched before stops
--     matching);
--   * for_you with search words orders by that relevance score instead of
--     ranked_feed's rank; the other orders are unchanged.
-- `required` and `entities` keep their meaning (an AND filter per tagged name,
-- and a reorder). The two feed_query_old overloads the renames left behind
-- are dropped: nothing calls them (the page calls the 8-argument one by name).
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
  )
  select s.id, s.rank
  from scored s
  order by s.mentions desc, s.rank desc, s.created_at desc, s.id desc
  offset page_offset
  limit page_size;
end
$$;

drop function if exists public.feed_query_old(text, text, text, timestamptz, integer, integer);
drop function if exists public.feed_query_old(text, text, text, timestamptz, integer, integer, uuid[]);
