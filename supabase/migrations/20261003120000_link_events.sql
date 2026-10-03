-- Events a link announces, with their dates, found by the event-extract
-- function from the link's own page.
--
-- link_content keeps the cleaned text of each fetched page (and any
-- schema.org Event objects it declares), so later steps can read a page
-- without fetching it again. It's third-party text: service_role only.
create table public.link_content (
  link_id uuid primary key references public.links (id) on delete cascade,
  fetched_at timestamptz not null default now(),
  status integer,
  lang text check (char_length(lang) <= 35),
  text text check (char_length(text) <= 20000),
  json_ld_events jsonb
);

alter table public.link_content enable row level security;

-- One row per event a link announces. A guide listing several events gives one
-- row each, `name` holding the heading it was listed under (null when the
-- page as a whole is the event). An open-ended run ("until 15 March") has no
-- start; a one-day event has no end. A dated session gets its own row, so a
-- show on three nights is three rows. `venue_entity_id` is one of the link's
-- place entities when a venue was matched; `venue_name` is the venue as the
-- page itself declares it (schema.org), unmatched. `evidence` is the text the
-- dates were read from. Public-read, service_role-write.
create table public.link_events (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links (id) on delete cascade,
  name text check (char_length(name) between 1 and 300),
  kind text not null check (kind in (
    'exhibition', 'concert', 'performance', 'screening', 'talk', 'festival',
    'market_fair', 'sport', 'family', 'party', 'tour', 'other'
  )),
  starts_on date,
  ends_on date,
  start_time time,
  venue_entity_id uuid references public.entities (id) on delete set null,
  venue_name text check (char_length(venue_name) between 1 and 300),
  evidence text check (char_length(evidence) <= 500),
  p real not null check (p > 0 and p <= 1),
  labeled_by text not null check (labeled_by in ('jev', 'json_ld', 'manual')),
  created_at timestamptz not null default now(),
  check (starts_on is not null or ends_on is not null),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  unique nulls not distinct (link_id, name, starts_on, ends_on)
);

create index link_events_link_id_idx on public.link_events (link_id);
create index link_events_dates_idx on public.link_events (coalesce(ends_on, starts_on), starts_on);

alter table public.link_events enable row level security;
create policy "link_events are public" on public.link_events for select to anon, authenticated using (true);

alter table public.link_enrichment add column events_at timestamptz;

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
    when 'relations' then e.relations_at is null and e.entities_at is not null
      and (select count(*) from link_entities le where le.link_id = l.id) >= 2
    when 'properties' then e.properties_at is null and e.entities_at is not null
      and exists (select 1 from link_entities le where le.link_id = l.id)
    when 'events' then e.events_at is null and e.entities_at is not null
    else false
  end
  order by l.created_at desc, l.id desc
  limit max_results
$$;
