-- related_links: the links most related to `link`, for its own page
-- (seb.now/p/<id>). Related means sharing entities (weighted double, since
-- "also about OpenAI" is more specific than "also about AI agents") or leaf
-- topics; each shared one adds p(this link) × p(that link). Newer links win
-- ties. Returns the shared entity and topic names so the page can say why.
-- security invoker: it reads only public-read tables.
create function public.related_links(link uuid, max_results integer default 10)
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
  limit max_results
$$;

grant execute on function public.related_links(uuid, integer) to anon, authenticated;
