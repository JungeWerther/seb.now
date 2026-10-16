-- filter_links pages by keyset instead of offset: a page starts after
-- (before_created_at, before_id), the last link of the page before, so a link
-- added meanwhile no longer shifts every later page by one (duplicating or
-- skipping a link) and a page is the same each time it's asked for, which is
-- what lets the page cache it (see frontend/src/filter.ts). Rows now carry
-- created_at for the next cursor.
--
-- page_offset stays (default 0) so a page still running the previous script
-- keeps working until it reloads; the new script never sets it.
drop function public.filter_links(jsonb, integer, integer);

create function public.filter_links(
  filters jsonb,
  max_results integer default 30,
  page_offset integer default 0,
  before_created_at timestamptz default null,
  before_id uuid default null
)
returns table (link_id uuid, entity_ids uuid[], created_at timestamptz)
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
  if (before_created_at is null) <> (before_id is null) then
    raise exception 'before_created_at and before_id go together' using errcode = '22023';
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
  select p.link_id, array_agg(distinct p.entity_id), l.created_at
  from passed p
  join links l on l.id = p.link_id
  where before_created_at is null or (l.created_at, l.id) < (before_created_at, before_id)
  group by p.link_id, l.id, l.created_at
  having count(distinct p.ord) = (select count(*) from f)
  order by l.created_at desc, l.id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 0), 100);
end
$$;

grant execute on function public.filter_links(jsonb, integer, integer, timestamptz, uuid) to anon, authenticated;
