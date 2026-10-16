-- Senses and indexicals.
--
-- A typed term stands for every sense it has at once, a superposition in the
-- MeTTa sense: "tonight" is the period that begins this evening, and it may
-- also be a film called "Tonight". A query keeps every branch; filter_links
-- reads a filter as the disjunction of its senses ({"any": [...]}) and filters
-- as a conjunction, so n ambiguous terms cost the sum of their senses, not
-- the product. What prunes a branch is a constraint (another filter, or the
-- page's own kind), never an early choice.
--
-- 1. Names are unique per kind, not globally: the same words can name a
--    place and a work, or a person and a company. entity-extract resolves a
--    name it calls new against the same name *and kind*.
--
-- 2. Indexicals ("tonight", "tomorrow", "this") are expressions, not
--    entities. Each has a character: a fixed rule from a context to what it
--    picks out. `context` says which part of the context: 'time' (the
--    reader's local wall-clock time, `at`) or 'focus' (what the reader is
--    looking at: an entity, a kind or a topic page). `kind_path` is the kind
--    of what it picks out: a Period for tonight and tomorrow, any entity for
--    "this". A time indexical's rule is offsets from the start of the
--    reader's day: interval = [d + starts_after, d + ends_after) with
--    d = (at - day_starts_at)::date, so tonight runs 18:00-04:00 and at 01:00
--    is still the night that began yesterday evening.
--
-- 3. An event's own interval (link_event_range) runs from its start_time,
--    else from event_day_starts() (06:00) on starts_on (unbounded for an
--    open-ended run with no start), to the end of ends_on, else of starts_on.
--    A date with no time means that day's waking hours, so an all-day market
--    tomorrow isn't on "tonight" through tonight's small hours. A one-day
--    event with a start_time and no end lasts event_default_duration()
--    (3 hours), so a 10:00 talk isn't on "tonight" either.

-- 1. Names unique per kind.
alter table public.entities drop constraint entities_name_key;
create unique index entities_name_kind_key on public.entities (lower(name), kind_path);

-- 2. Indexicals.
create table public.indexicals (
  term text primary key check (term ~ '^[a-z]+( [a-z]+)*$'),
  kind_path ltree not null references public.kinds (path),
  context text not null check (context in ('time', 'focus')),
  day_starts_at interval,
  starts_after interval,
  ends_after interval,
  description text not null check (char_length(description) between 1 and 300),
  check ((context = 'time') = (day_starts_at is not null and starts_after is not null and ends_after is not null)),
  check (ends_after > starts_after)
);

alter table public.indexicals enable row level security;
create policy "indexicals are public" on public.indexicals for select to anon, authenticated using (true);

insert into public.indexicals (term, kind_path, context, day_starts_at, starts_after, ends_after, description) values
  ('tonight', 'entity.period', 'time', '4 hours', '18 hours', '28 hours',
   'The evening and night ahead, 18:00 to 04:00 local time; after midnight, the night that is ending'),
  ('tomorrow', 'entity.period', 'time', '0', '24 hours', '48 hours',
   'The whole of the next day, local time'),
  ('this', 'entity', 'focus', null, null, null,
   'Whatever you are looking at: the entity, kind or topic whose page you typed on');

update public.kinds
set description = 'A span of time; denotes an interval [from, to). Named by indexicals such as tonight and tomorrow'
where path = 'entity.period';

-- The interval a time indexical picks out when read at local time `at`.
create function public.indexical_interval(term text, at timestamp)
returns tsrange
language sql
stable
security invoker
set search_path = public
as $$
  select tsrange(d + i.starts_after, d + i.ends_after, '[)')
  from indexicals i, lateral (select (at - i.day_starts_at)::date as d) day
  where i.term = indexical_interval.term and i.context = 'time'
$$;

-- 3. An event's own interval, in local wall-clock time.
create function public.event_default_duration() returns interval
language sql immutable as $$ select interval '3 hours' $$;

create function public.event_day_starts() returns time
language sql immutable as $$ select time '06:00' $$;

create function public.link_event_range(starts_on date, ends_on date, start_time time)
returns tsrange
language sql
immutable
as $$
  select tsrange(
    starts_on + coalesce(start_time, event_day_starts()),
    case
      when start_time is not null and coalesce(ends_on, starts_on) = starts_on
        then starts_on + start_time + event_default_duration()
      else (coalesce(ends_on, starts_on) + 1)::timestamp
    end,
    '[)')
$$;

-- What an indexical's page shows: what it picks out now (a time indexical's
-- interval) and how many links have an event in it.
create function public.indexical_summary(term text, at timestamp)
returns table (kind_path text, context text, description text, starts timestamp, ends timestamp, posts integer)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select i.kind_path::text, i.context, i.description, lower(r.r), upper(r.r),
    case when r.r is not null then
      (select count(distinct ev.link_id)::integer from link_events ev
       where link_event_range(ev.starts_on, ev.ends_on, ev.start_time) && r.r)
    end
  from indexicals i
  cross join lateral (select indexical_interval(i.term, at) as r) r
  where i.term = indexical_summary.term
$$;

-- One sense of a filter, checked and with any indexical resolved against its
-- context, as one of {"kind"}, {"entities"}, {"topic"} or {"period": [from, to]}.
--   {"kind": "entity.event"}             mentions an entity of that kind;
--   {"entities": [uuid, ...]}            mentions one of these;
--   {"topic": "culture.cinema"}          is labelled with the topic or below;
--   {"period": [from, to]}               has an event overlapping it;
--   {"indexical": "tonight", "at": ts}   a time indexical, read at `at`;
--   {"indexical": "this", "focus": {"entity": uuid} | {"kind": path} | {"topic": path}}.
create function public.filter_sense(sense jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  ctx text;
  r tsrange;
begin
  if jsonb_typeof(sense) is distinct from 'object'
      or (sense ? 'kind')::int + (sense ? 'entities')::int + (sense ? 'topic')::int
         + (sense ? 'period')::int + (sense ? 'indexical')::int <> 1 then
    raise exception 'a sense has exactly one of kind, entities, topic, period, indexical' using errcode = '22023';
  end if;
  if sense ? 'indexical' then
    select i.context into ctx from indexicals i where i.term = sense->>'indexical';
    if ctx is null then
      raise exception 'unknown indexical %', sense->>'indexical' using errcode = '22023';
    elsif ctx = 'time' then
      if (sense->>'at') is null then
        raise exception 'the time indexical % needs at', sense->>'indexical' using errcode = '22023';
      end if;
      r := indexical_interval(sense->>'indexical', (sense->>'at')::timestamp);
      return jsonb_build_object('period', jsonb_build_array(lower(r), upper(r)));
    else
      if jsonb_typeof(sense->'focus') is distinct from 'object' then
        raise exception 'the focus indexical % needs focus', sense->>'indexical' using errcode = '22023';
      end if;
      return filter_sense(case
        when sense->'focus' ? 'entity' then jsonb_build_object('entities', jsonb_build_array(sense->'focus'->'entity'))
        else sense->'focus'
      end);
    end if;
  end if;
  if sense ? 'kind' and (sense->>'kind') !~ '^entity(\.[a-z_]+)*$' then
    raise exception 'unknown kind %', sense->>'kind' using errcode = '22023';
  end if;
  if sense ? 'topic' and (sense->>'topic') !~ '^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$' then
    raise exception 'bad topic %', sense->>'topic' using errcode = '22023';
  end if;
  if sense ? 'entities' and (jsonb_typeof(sense->'entities') is distinct from 'array'
      or jsonb_array_length(sense->'entities') not between 1 and 8) then
    raise exception 'entities must be an array of 1 to 8 ids' using errcode = '22023';
  end if;
  if sense ? 'period' and (jsonb_typeof(sense->'period') is distinct from 'array'
      or jsonb_array_length(sense->'period') <> 2
      or (sense->'period'->>0)::timestamp >= (sense->'period'->>1)::timestamp) then
    raise exception 'period must be [from, to] with from before to' using errcode = '22023';
  end if;
  return sense;
end
$$;

-- A query made only of filters: the links passing every filter (conjunction),
-- each filter passed by any one of its senses (disjunction), newest first,
-- with the entities matched along the way as `entity_ids` (the Writer log the
-- page lights chips from). A filter is a sense, or {"any": [sense, ...]} for a
-- term with several (1 to 8); `filters` is 1 to 8 filters.
create or replace function public.filter_links(filters jsonb, max_results integer default 30, page_offset integer default 0)
returns table (link_id uuid, entity_ids uuid[])
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
  select p.link_id, coalesce(array_agg(distinct p.entity_id) filter (where p.entity_id is not null), '{}')
  from passed p
  join links l on l.id = p.link_id
  group by p.link_id, l.created_at
  having count(distinct p.ord) = (select count(distinct f.ord) from f)
  order by l.created_at desc, p.link_id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 0), 100);
end
$$;

grant execute on function public.indexical_interval(text, timestamp) to anon, authenticated;
grant execute on function public.event_default_duration() to anon, authenticated;
grant execute on function public.event_day_starts() to anon, authenticated;
grant execute on function public.link_event_range(date, date, time) to anon, authenticated;
grant execute on function public.indexical_summary(text, timestamp) to anon, authenticated;
grant execute on function public.filter_sense(jsonb) to anon, authenticated;
