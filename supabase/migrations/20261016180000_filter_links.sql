-- A query made only of filters ("event paris": the kind Event and the place
-- Paris) lists the links that pass every one of them, newest first.
--
-- Filters compose like a Writer monad: `bind` is conjunction, and each filter
-- a link passes also writes to a log, the entities it matched there, which
-- come back as `entity_ids` so the page can light up those chips. The unit is
-- the filter every link passes, logging nothing. Kept to the two filters the
-- page builds:
--   {"kind": "entity.event"}     a link mentioning an entity of that kind or
--                                one of its subkinds;
--   {"entities": [uuid, ...]}    a link mentioning any of these (one typed
--                                name can be several entities: disjunction
--                                inside a filter, conjunction between them).
-- `filters` is a JSON array of 1 to 8 of them. A link mentioning one entity
-- that passes two filters (Paris Fashion Week is an event; it isn't Paris)
-- still needs each filter passed by some entity of its own choosing.
create function public.filter_links(filters jsonb, max_results integer default 30, page_offset integer default 0)
returns table (link_id uuid, entity_ids uuid[])
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  term jsonb;
begin
  if jsonb_typeof(filters) is distinct from 'array' or jsonb_array_length(filters) not between 1 and 8 then
    raise exception 'filters must be an array of 1 to 8 filters' using errcode = '22023';
  end if;
  for term in select * from jsonb_array_elements(filters) loop
    if jsonb_typeof(term) is distinct from 'object' or (term ? 'kind') = (term ? 'entities') then
      raise exception 'a filter has exactly one of kind, entities' using errcode = '22023';
    end if;
    if term ? 'kind' and (term->>'kind') !~ '^entity(\.[a-z_]+)*$' then
      raise exception 'unknown kind %', term->>'kind' using errcode = '22023';
    end if;
    if term ? 'entities' and (jsonb_typeof(term->'entities') is distinct from 'array'
        or jsonb_array_length(term->'entities') not between 1 and 8) then
      raise exception 'entities must be an array of 1 to 8 ids' using errcode = '22023';
    end if;
  end loop;

  return query
  with f as (
    select x.ord,
      (x.term->>'kind')::ltree as kind,
      case when x.term ? 'entities'
        then array(select jsonb_array_elements_text(x.term->'entities')::uuid)
      end as ids
    from jsonb_array_elements(filters) with ordinality as x(term, ord)
  ),
  -- The log: which filter each mention passes.
  passed as (
    select le.link_id, f.ord, le.entity_id
    from f
    join link_entities le on f.ids is not null and le.entity_id = any(f.ids)
    union all
    select le.link_id, f.ord, le.entity_id
    from f
    join entities e on f.kind is not null and e.kind_path <@ f.kind
    join link_entities le on le.entity_id = e.id
  )
  select p.link_id, array_agg(distinct p.entity_id)
  from passed p
  join links l on l.id = p.link_id
  group by p.link_id, l.created_at
  having count(distinct p.ord) = (select count(*) from f)
  order by l.created_at desc, p.link_id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 0), 100);
end
$$;

grant execute on function public.filter_links(jsonb, integer, integer) to anon, authenticated;
