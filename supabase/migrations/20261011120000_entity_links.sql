-- Every link that mentions an entity, newest first, for its page (/e/<id>).
-- Paged like related_links so per-page vote/reply lookups stay page-sized;
-- id breaks created_at ties, since one ingest upsert stamps all its rows alike.
create function public.entity_links(entity uuid, max_results integer default 30, page_offset integer default 0)
returns table (link_id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  select l.id
  from link_entities le
  join links l on l.id = le.link_id
  where le.entity_id = entity
  order by l.created_at desc, l.id desc
  offset page_offset
  limit max_results
$$;

grant execute on function public.entity_links(uuid, integer, integer) to anon, authenticated;
