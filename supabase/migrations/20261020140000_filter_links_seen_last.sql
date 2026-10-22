-- A filter search that asks for what's new ("events in paris, new") lists the
-- links the caller has seen last, as feed_query's latest order does: seen
-- (clicked, link_visits, or had on screen, link_impressions) at or before
-- `as_of`, each part newest first. `seen_last` turns it on; without it the
-- order is newest first as before, and so is a caller with no session.
-- Keyset pages carry where they stopped as (seen, created_at, id), so a page
-- starts after `before_seen` too; rows carry `seen` for the next cursor.
--
-- The body is 20261017130000_filter_links_keyset's filter_links plus the
-- order. The new arguments default to the old behaviour, so a page still
-- running the previous script keeps working. The return type changes, hence
-- drop and create.
drop function public.filter_links(jsonb, integer, integer, timestamptz, uuid);

create function public.filter_links(
  filters jsonb,
  max_results integer default 30,
  page_offset integer default 0,
  before_created_at timestamptz default null,
  before_id uuid default null,
  seen_last boolean default false,
  as_of timestamptz default null,
  before_seen boolean default null
)
returns table (link_id uuid, entity_ids uuid[], created_at timestamptz, seen boolean)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  viewer uuid := auth.uid();
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
  if seen_last and as_of is null then
    raise exception 'seen_last needs as_of' using errcode = '22023';
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
  ),
  matched as (
    select p.link_id, coalesce(array_agg(distinct p.entity_id) filter (where p.entity_id is not null), '{}') as entity_ids,
      l.created_at
    from passed p
    join links l on l.id = p.link_id
    group by p.link_id, l.created_at
    having count(distinct p.ord) = (select count(distinct f.ord) from f)
  ),
  ordered as (
    select m.*,
      seen_last and viewer is not null and (
        exists (
          select 1 from link_visits lv
          where lv.link_id = m.link_id and lv.visitor_id = viewer and lv.visited_at <= as_of
        )
        or exists (
          select 1 from link_impressions li
          where li.viewer_id = viewer and li.link_id = m.link_id and li.seen_at <= as_of
        )
      ) as seen
    from matched m
  )
  select o.link_id, o.entity_ids, o.created_at, o.seen
  from ordered o
  where before_created_at is null
    or o.seen > coalesce(before_seen, false)
    or (o.seen = coalesce(before_seen, false) and (o.created_at, o.link_id) < (before_created_at, before_id))
  order by o.seen, o.created_at desc, o.link_id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 0), 100);
end
$$;

grant execute on function public.filter_links(jsonb, integer, integer, timestamptz, uuid, boolean, timestamptz, boolean) to anon, authenticated;
