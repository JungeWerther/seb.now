-- Periods: "tonight", "tomorrow". A period is a kind of thing a query can
-- name, and what it denotes is an interval of time, [from, to), relative to
-- when it's typed. The page resolves the name (it knows the reader's clock)
-- and filter_links takes the interval as a third kind of filter:
--   {"period": ["2026-10-16T18:00", "2026-10-17T04:00"]}
-- in local wall-clock time, the way link_events' dates and times are written.
-- A link passes it when one of its events overlaps that interval. An event's
-- own interval runs from its start (its start_time, else the start of
-- starts_on; unbounded for an open-ended run with no start) to the end of
-- ends_on (or of starts_on, for a one-day event). So "tonight" keeps a party
-- at 23:00, an exhibition running all month and a club night starting at
-- 02:00, but not a talk tomorrow morning. Periods log no entities.
insert into public.kinds (path, label, description) values
  ('entity.period', 'Period', 'A span of time; denotes an interval [from, to), e.g. tonight, tomorrow');

create or replace function public.filter_links(filters jsonb, max_results integer default 30, page_offset integer default 0)
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
    if jsonb_typeof(term) is distinct from 'object'
        or (term ? 'kind')::int + (term ? 'entities')::int + (term ? 'period')::int <> 1 then
      raise exception 'a filter has exactly one of kind, entities, period' using errcode = '22023';
    end if;
    if term ? 'kind' and (term->>'kind') !~ '^entity(\.[a-z_]+)*$' then
      raise exception 'unknown kind %', term->>'kind' using errcode = '22023';
    end if;
    if term ? 'entities' and (jsonb_typeof(term->'entities') is distinct from 'array'
        or jsonb_array_length(term->'entities') not between 1 and 8) then
      raise exception 'entities must be an array of 1 to 8 ids' using errcode = '22023';
    end if;
    if term ? 'period' and (jsonb_typeof(term->'period') is distinct from 'array'
        or jsonb_array_length(term->'period') <> 2
        or (term->'period'->>0)::timestamp >= (term->'period'->>1)::timestamp) then
      raise exception 'period must be [from, to] with from before to' using errcode = '22023';
    end if;
  end loop;

  return query
  with f as (
    select x.ord,
      (x.term->>'kind')::ltree as kind,
      case when x.term ? 'entities'
        then array(select jsonb_array_elements_text(x.term->'entities')::uuid)
      end as ids,
      case when x.term ? 'period'
        then tsrange((x.term->'period'->>0)::timestamp, (x.term->'period'->>1)::timestamp, '[)')
      end as period
    from jsonb_array_elements(filters) with ordinality as x(term, ord)
  ),
  -- The log: which filter each mention passes (a period passes with no entity).
  passed as (
    select le.link_id, f.ord, le.entity_id
    from f
    join link_entities le on f.ids is not null and le.entity_id = any(f.ids)
    union all
    select le.link_id, f.ord, le.entity_id
    from f
    join entities e on f.kind is not null and e.kind_path <@ f.kind
    join link_entities le on le.entity_id = e.id
    union all
    select ev.link_id, f.ord, null::uuid
    from f
    join link_events ev on f.period is not null
      and tsrange(ev.starts_on + coalesce(ev.start_time, time '00:00'),
                  (coalesce(ev.ends_on, ev.starts_on) + 1)::timestamp, '[)') && f.period
  )
  select p.link_id, coalesce(array_agg(distinct p.entity_id) filter (where p.entity_id is not null), '{}')
  from passed p
  join links l on l.id = p.link_id
  group by p.link_id, l.created_at
  having count(distinct p.ord) = (select count(*) from f)
  order by l.created_at desc, p.link_id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 0), 100);
end
$$;
