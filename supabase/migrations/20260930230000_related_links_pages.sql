-- related_links in pages, for the link page's infinite scroll: the same
-- ranking (shared entities count double, shared leaf topics once, p × p each,
-- newer first on ties), now with a page_offset. The order is total (score,
-- then created_at, then id), so consecutive pages neither skip nor repeat.
drop function public.related_links(uuid, integer);

create function public.related_links(link uuid, max_results integer default 10, page_offset integer default 0)
returns table (link_id uuid, score double precision, shared_entities text[], shared_topics text[])
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with by_entity as (
    select other.link_id,
      2 * sum(mine.p * other.p) as score,
      array_agg(e.name order by mine.p * other.p desc, e.name) as names
    from link_entities mine
    join link_entities other on other.entity_id = mine.entity_id and other.link_id <> mine.link_id
    join entities e on e.id = mine.entity_id
    where mine.link_id = link
    group by other.link_id
  ),
  by_topic as (
    select other.link_id,
      sum(mine.p * other.p) as score,
      array_agg(t.name order by mine.p * other.p desc, t.name) as names
    from link_topics mine
    join link_topics other on other.topic_id = mine.topic_id and other.link_id <> mine.link_id
    join topics t on t.id = mine.topic_id
    where mine.link_id = link
    group by other.link_id
  )
  select l.id,
    coalesce(e.score, 0) + coalesce(t.score, 0),
    coalesce(e.names, '{}'),
    coalesce(t.names, '{}')
  from by_entity e
  full join by_topic t on t.link_id = e.link_id
  join links l on l.id = coalesce(e.link_id, t.link_id)
  order by 2 desc, l.created_at desc, l.id
  offset page_offset
  limit max_results
$$;

grant execute on function public.related_links(uuid, integer, integer) to anon, authenticated;
