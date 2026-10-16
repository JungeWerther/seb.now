-- filter_links pages by keyset as well as offset: a page starts after
-- (before_created_at, before_id), the last link of the page before, so a link
-- added meanwhile no longer shifts every later page by one (duplicating or
-- skipping a link), and a page is the same each time it's asked for, which is
-- what lets the page cache it (frontend/src/filter.ts). Rows now carry
-- created_at for the next cursor.
--
-- The body is 20261016235000_senses_and_indexicals' filter_links unchanged
-- (senses, {"any": [...]}, indexicals), plus the cursor. page_offset stays
-- (default 0), so a page still running the previous script keeps working
-- until it reloads. The return type changes, hence drop and create.
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
begin
  if jsonb_typeof(filters) is distinct from 'array' or jsonb_array_length(filters) not between 1 and 8 then
    raise exception 'filters must be an array of 1 to 8 filters' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(filters) t
    where t ? 'any' and (jsonb_typeof(t->'any') is distinct from 'array' or jsonb_array_length(t->'any') not between 1 and 8)
  ) then
    raise exception 'any must be an array of 1 to 8 senses' using errcode = '22023';
  end if;
  if (before_created_at is null) <> (before_id is null) then
    raise exception 'before_created_at and before_id go together' using errcode = '22023';
  end if;

  return query
  with s as materialized (
    select x.ord, filter_sense(y.sense) as sense
    from jsonb_array_elements(filters) with ordinality as x(term, ord)
    cross join lateral jsonb_array_elements(
      case when x.term ? 'any' then x.term->'any' else jsonb_build_array(x.term) end
    ) as y(sense)
  ),
  f as (
    select s.ord,
      (s.sense->>'kind')::ltree as kind,
      case when s.sense ? 'entities'
        then array(select jsonb_array_elements_text(s.sense->'entities')::uuid)
      end as ids,
      (s.sense->>'topic')::ltree as topic,
      case when s.sense ? 'period'
        then tsrange((s.sense->'period'->>0)::timestamp, (s.sense->'period'->>1)::timestamp, '[)')
      end as period
    from s
  ),
  -- The log: which filter each mention passes (a topic or a period passes
  -- with no entity).
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
    select lt.link_id, f.ord, null::uuid
    from f
    join link_topics lt on f.topic is not null and lt.topic_id <@ f.topic
    union all
    select ev.link_id, f.ord, null::uuid
    from f
    join link_events ev on f.period is not null
      and link_event_range(ev.starts_on, ev.ends_on, ev.start_time) && f.period
  )
  select p.link_id, coalesce(array_agg(distinct p.entity_id) filter (where p.entity_id is not null), '{}'), l.created_at
  from passed p
  join links l on l.id = p.link_id
  where before_created_at is null or (l.created_at, l.id) < (before_created_at, before_id)
  group by p.link_id, l.created_at, l.id
  having count(distinct p.ord) = (select count(distinct f.ord) from f)
  order by l.created_at desc, p.link_id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 0), 100);
end
$$;

grant execute on function public.filter_links(jsonb, integer, integer, timestamptz, uuid) to anon, authenticated;
