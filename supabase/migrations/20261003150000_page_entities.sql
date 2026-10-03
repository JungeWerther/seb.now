-- entity-extract reads the page a link points to as well as its title.
-- `found_in` says where a mention was found; an entity both name keeps its
-- title row. Page mentions are many and weaker (a guide names dozens of
-- places), so related_links and the link page's chips stay on title mentions.
alter table public.link_entities
  add column found_in text not null default 'title' check (found_in in ('title', 'page'));

alter table public.link_enrichment add column page_entities_at timestamptz;

-- 'page_entities' follows the title pass; 'events' now waits for the page
-- pass, which fetches the page into link_content and finds the venues.
-- 'relations' and 'properties' read titles, so they count title mentions.
create or replace function public.links_to_enrich(step text, max_results integer)
returns table (link_id uuid)
language sql
stable
set search_path = public
as $$
  select l.id
  from links l
  left join link_enrichment e on e.link_id = l.id
  where case step
    when 'topics' then e.topics_at is null
      and not exists (select 1 from link_topics lt where lt.link_id = l.id)
    when 'entities' then e.entities_at is null
    when 'page_entities' then e.page_entities_at is null and e.entities_at is not null
    when 'relations' then e.relations_at is null and e.entities_at is not null
      and (select count(*) from link_entities le where le.link_id = l.id and le.found_in = 'title') >= 2
    when 'properties' then e.properties_at is null and e.entities_at is not null
      and exists (select 1 from link_entities le where le.link_id = l.id and le.found_in = 'title')
    when 'events' then e.events_at is null and e.page_entities_at is not null
    else false
  end
  order by l.created_at desc, l.id desc
  limit max_results
$$;

create or replace function public.related_links(link uuid, max_results integer default 10, page_offset integer default 0)
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
      and other.found_in = 'title'
    join entities e on e.id = mine.entity_id
    where mine.link_id = link and mine.found_in = 'title'
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
