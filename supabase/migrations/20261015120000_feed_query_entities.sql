-- The entities the search box suggests for the typed text (match_entities)
-- rank first in a query's results: a link mentioning any of them comes before
-- every link that doesn't, each group in the query's own order. They only
-- reorder what the query already matches, never add links to it.
drop function public.feed_query(text, text, text, timestamptz, integer, integer);

create function public.feed_query(
  sort text,
  topic text,
  search text,
  as_of timestamptz,
  page_offset integer default 0,
  page_size integer default 30,
  entities uuid[] default null
)
returns table (link_id uuid, rank double precision)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  words text[] := array(
    select replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')
    from regexp_split_to_table(fold_text(coalesce(search, '')), '\s+') w
    where w <> ''
  );
begin
  if sort not in ('for_you', 'latest', 'top', 'discussed') then
    raise exception 'unknown sort %', sort using errcode = '22023';
  end if;
  return query
  with matching as (
    select l.id, l.created_at,
      coalesce(cardinality(entities), 0) > 0 and exists (
        select 1 from link_entities le where le.link_id = l.id and le.entity_id = any(entities)
      ) as mentions
    from links l
    where l.created_at <= as_of
      and (topic is null or exists (
        select 1 from link_topics lt where lt.link_id = l.id and lt.topic_id <@ topic::ltree
      ))
      and not exists (select 1 from unnest(words) w where fold_text(l.search_text) not like '%' || w || '%')
  ),
  scored as (
    select m.id, m.created_at, m.mentions,
      case sort
        when 'latest' then extract(epoch from m.created_at)::double precision
        when 'top' then (
          select coalesce(sum(v.value), 0)::double precision from votes v where v.link_id = m.id
        )
        when 'discussed' then (
          select count(*)::double precision from replies r where r.link_id = m.id
        )
      end as rank
    from matching m
    where sort <> 'for_you'
    union all
    select m.id, m.created_at, m.mentions, r.rank
    from matching m
    join ranked_feed(as_of, 0, 2147483647) r on r.link_id = m.id
    where sort = 'for_you'
  )
  select s.id, s.rank
  from scored s
  order by s.mentions desc, s.rank desc, s.created_at desc, s.id desc
  offset page_offset
  limit page_size;
end
$$;

grant execute on function public.feed_query(text, text, text, timestamptz, integer, integer, uuid[]) to anon, authenticated;
