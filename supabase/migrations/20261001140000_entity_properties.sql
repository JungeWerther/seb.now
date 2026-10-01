-- entity_properties: what links say an entity *is* ("British AI neocloud
-- Nscale"), each a claim made by one link, like entity_relations. `facet` is
-- the kind of description: domain (a field it works in, mapped onto a topic
-- when one fits, so `'ai' @> topic_id` finds every AI-described entity), origin,
-- stage, type, or evaluation (a framing, which is the publication's view: join
-- links for the source). `former` marks "former coach" / "ex-CEO". `value`
-- keeps the words as written, lowercased. Public-read, service_role-write.
create table public.entity_properties (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  link_id uuid not null references public.links (id) on delete cascade,
  facet text not null check (facet in ('domain', 'origin', 'stage', 'type', 'evaluation')),
  value text not null check (char_length(value) between 1 and 100),
  topic_id extensions.ltree references public.topics (id) on update cascade on delete set null,
  former boolean not null default false,
  p real not null default 1 check (p > 0 and p <= 1),
  labeled_by text not null default 'manual' check (labeled_by in ('manual', 'jev')),
  created_at timestamptz not null default now(),
  unique (link_id, entity_id, facet, value)
);

create index entity_properties_entity_idx on public.entity_properties (entity_id);
create index entity_properties_value_idx on public.entity_properties (facet, value);
create index entity_properties_topic_idx on public.entity_properties using gist (topic_id);

alter table public.entity_properties enable row level security;
create policy "entity properties are publicly readable"
  on public.entity_properties for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.entity_properties from anon, authenticated;

-- entity_property_summary: one row per (entity, facet, value) over all the
-- links saying it, combined by noisy-OR like entity_relation_summary; the
-- topic is the most confident one any link mapped it to, and `former` is what
-- the newest link says.
create view public.entity_property_summary
with (security_invoker = true)
as
select
  pr.entity_id,
  pr.facet,
  pr.value,
  (array_agg(pr.topic_id order by pr.p desc) filter (where pr.topic_id is not null))[1] as topic_id,
  (array_agg(pr.former order by l.created_at desc, l.id desc))[1] as former,
  count(*)::integer as links,
  (1 - exp(sum(ln(1 - least(pr.p, 0.999)::double precision))))::real as p,
  min(l.created_at) as first_seen,
  max(l.created_at) as last_seen
from public.entity_properties pr
join public.links l on l.id = pr.link_id
group by pr.entity_id, pr.facet, pr.value;

grant select on public.entity_property_summary to anon, authenticated;

-- A relation can be over too ("former CEO", "ex-partner").
alter table public.entity_relations drop constraint entity_relations_status_check;
alter table public.entity_relations add constraint entity_relations_status_check
  check (status in ('stated', 'planned', 'called_off', 'disputed', 'ended'));

alter table public.link_enrichment add column properties_at timestamptz;

-- 'properties' picks links whose entities have been extracted and that mention
-- at least one.
create or replace function public.links_to_enrich(step text, max_results integer)
returns table (link_id uuid)
language sql
stable
security invoker
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
    else false
  end
  order by l.created_at desc, l.id desc
  limit max_results
$$;

revoke execute on function public.links_to_enrich(text, integer) from public, anon, authenticated;
