-- A kind's page (/k/<path>): the links mentioning an entity of that kind or
-- one of its subkinds, newest first, each with the entities that matched (so
-- the page can highlight their chips); its best-covered entities; and its
-- counts. `kind` is text since PostgREST passes RPC arguments as JSON strings,
-- and is qualified in the bodies because entities has a `kind` column too.
create function public.kind_links(kind text, max_results integer default 30, page_offset integer default 0)
returns table (link_id uuid, entity_ids uuid[])
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select l.id, array(
    select le.entity_id
    from link_entities le join entities e on e.id = le.entity_id
    where le.link_id = l.id and e.kind_path <@ kind_links.kind::ltree
  )
  from links l
  where exists (
    select 1 from link_entities le join entities e on e.id = le.entity_id
    where le.link_id = l.id and e.kind_path <@ kind_links.kind::ltree
  )
  order by l.created_at desc, l.id desc
  offset page_offset
  limit max_results
$$;

create function public.kind_entities(kind text, max_results integer default 12)
returns table (id uuid, name text, kind_path text, posts bigint)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select e.id, e.name, e.kind_path::text, count(le.link_id) as posts
  from entities e
  left join link_entities le on le.entity_id = e.id
  where e.kind_path <@ kind_entities.kind::ltree
  group by e.id
  order by posts desc, e.name, e.id
  limit least(max_results, 50)
$$;

create function public.kind_counts(kind text)
returns table (entities integer, posts integer)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    (select count(*) from entities e where e.kind_path <@ kind_counts.kind::ltree)::integer,
    (select count(distinct le.link_id)
       from link_entities le join entities e on e.id = le.entity_id
       where e.kind_path <@ kind_counts.kind::ltree)::integer
$$;

grant execute on function public.kind_links(text, integer, integer) to anon, authenticated;
grant execute on function public.kind_entities(text, integer) to anon, authenticated;
grant execute on function public.kind_counts(text) to anon, authenticated;
