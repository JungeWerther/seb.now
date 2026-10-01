-- entity_relations: typed relations between entities, each a claim made by one
-- link ("Databricks acquires Row Zero", according to that article), so reports,
-- rumours and denials sit side by side and confidence can be summed over links.
-- `status` says what the link claims about it: done or true (stated), only
-- announced or planned, called off, or disputed by a party. Symmetric relations
-- are stored once, with the smaller id as subject. Public-read,
-- service_role-write like link_entities.
create table public.entity_relations (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.entities (id) on delete cascade,
  relation text not null check (relation in (
    'acquires', 'invests_in', 'customer_of', 'part_of', 'makes', 'leads', 'works_for',
    'sues', 'regulates', 'criticizes', 'located_in', 'partners_with', 'competes_with'
  )),
  object_id uuid not null references public.entities (id) on delete cascade,
  link_id uuid not null references public.links (id) on delete cascade,
  status text not null default 'stated' check (status in ('stated', 'planned', 'called_off', 'disputed')),
  p real not null default 1 check (p > 0 and p <= 1),
  labeled_by text not null default 'manual' check (labeled_by in ('manual', 'jev')),
  created_at timestamptz not null default now(),
  check (subject_id <> object_id),
  check (relation not in ('partners_with', 'competes_with') or subject_id < object_id),
  unique (link_id, subject_id, relation, object_id)
);

create index entity_relations_subject_idx on public.entity_relations (subject_id, relation);
create index entity_relations_object_idx on public.entity_relations (object_id, relation);

alter table public.entity_relations enable row level security;
create policy "entity relations are publicly readable"
  on public.entity_relations for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.entity_relations from anon, authenticated;

alter table public.link_enrichment add column relations_at timestamptz;

-- 'relations' only picks links whose entities have been extracted and that
-- mention at least two, since a relation needs a pair.
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
    else false
  end
  order by l.created_at desc, l.id desc
  limit max_results
$$;

revoke execute on function public.links_to_enrich(text, integer) from public, anon, authenticated;
