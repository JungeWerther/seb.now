-- Witnesses of sameness: each row says that, in one sense, an entity has a
-- value, on the evidence of one link (or of no link, when the value was only
-- ever stored flattened). Two witnesses of the same sense and value make the
-- two entities the same in that sense; merge_proposals() composes them.
--
-- Senses so far:
--   label  value = a surface the entity was mentioned by, normalised
--          (lowercased, trimmed, ’ as '); one row per mention in
--          link_entities, kept in step by a trigger.
--   kind   value = entities.kind; link_id null, labeled_by 'entities.kind',
--          until entity-extract records Jev's per-link kind answer here.
-- service_role only.
create table public.identity_witnesses (
  id bigint generated always as identity primary key,
  sense text not null check (sense in ('label', 'kind')),
  entity_id uuid not null references public.entities (id) on delete cascade,
  value text not null check (char_length(value) between 1 and 300),
  link_id uuid references public.links (id) on delete cascade,
  surface text,
  p real not null check (p > 0 and p <= 1),
  labeled_by text not null,
  created_at timestamptz not null default now(),
  unique nulls not distinct (sense, entity_id, value, link_id)
);

create index identity_witnesses_sense_value on public.identity_witnesses (sense, value);

alter table public.identity_witnesses enable row level security;
revoke all on public.identity_witnesses from anon, authenticated;

create function public.witness_label(surface text) returns text
language sql immutable as $$
  select nullif(replace(lower(btrim(surface)), '’', ''''), '')
$$;

insert into public.identity_witnesses (sense, entity_id, value, link_id, surface, p, labeled_by)
select 'label', le.entity_id, public.witness_label(le.surface), le.link_id, le.surface, le.p, le.labeled_by
from public.link_entities le
where public.witness_label(le.surface) is not null
  and char_length(public.witness_label(le.surface)) <= 300
on conflict do nothing;

insert into public.identity_witnesses (sense, entity_id, value, p, labeled_by)
select 'kind', e.id, e.kind, 1, 'entities.kind'
from public.entities e
on conflict do nothing;

create function public.link_entities_add_witness() returns trigger
language plpgsql as $$
begin
  if public.witness_label(new.surface) is not null
     and char_length(public.witness_label(new.surface)) <= 300 then
    insert into public.identity_witnesses (sense, entity_id, value, link_id, surface, p, labeled_by)
    values ('label', new.entity_id, public.witness_label(new.surface), new.link_id, new.surface, new.p, new.labeled_by)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger link_entities_add_witness
  after insert on public.link_entities
  for each row execute function public.link_entities_add_witness();

create function public.entities_add_kind_witness() returns trigger
language plpgsql as $$
begin
  insert into public.identity_witnesses (sense, entity_id, value, p, labeled_by)
  values ('kind', new.id, new.kind, 1, 'entities.kind')
  on conflict do nothing;
  return new;
end;
$$;

create trigger entities_add_kind_witness
  after insert on public.entities
  for each row execute function public.entities_add_kind_witness();

-- Pairs of entities that are the same by label and by kind (the meet of the
-- two senses), as candidates for being one entity. For each shared label the
-- best witness on each side is composed (p_a * p_b), divided among the
-- entities sharing that label; labels combine as independent evidence
-- (noisy-OR). Pairs whose wikidata ids are both set and differ are left out.
-- `evidence` lists each shared label with the link behind each side;
-- `co_mentions` counts links mentioning both, as separate entities.
-- A review queue, not a merge: same label and kind still pairs a product
-- with its parts and versions (Mac / macOS).
create function public.merge_proposals(max_results integer default 50, min_score real default 0.5)
returns table (
  entity_a uuid, name_a text, entity_b uuid, name_b text, kind text,
  score real, evidence jsonb, co_mentions integer
)
language sql stable security invoker as $$
  with labels as (
    select entity_id, value, link_id, p
    from public.identity_witnesses where sense = 'label'
  ),
  shared as (
    select value, count(distinct entity_id) as n
    from labels group by value having count(distinct entity_id) > 1
  ),
  best as (
    select l.entity_id, l.value, s.n,
           (array_agg(l.link_id order by l.p desc))[1] as link_id, max(l.p) as p
    from labels l join shared s using (value)
    group by l.entity_id, l.value, s.n
  ),
  kinds as (
    select entity_id, value as kind, max(p) as p
    from public.identity_witnesses where sense = 'kind'
    group by entity_id, value
  ),
  paths as (
    select a.entity_id as a, b.entity_id as b, ka.kind, a.value,
           a.link_id as link_a, b.link_id as link_b,
           a.p * b.p * ka.p * kb.p / (a.n - 1) as p
    from best a
    join best b on b.value = a.value and a.entity_id < b.entity_id
    join kinds ka on ka.entity_id = a.entity_id
    join kinds kb on kb.entity_id = b.entity_id and kb.kind = ka.kind
  ),
  scored as (
    select a, b, kind,
           1 - exp(sum(ln(1 - least(p, 0.999999)))) as score,
           jsonb_agg(jsonb_build_object(
             'label', value, 'link_a', link_a, 'link_b', link_b, 'p', round(p::numeric, 3)
           ) order by p desc) as evidence
    from paths group by a, b, kind
  )
  select s.a, ea.name, s.b, eb.name, s.kind, s.score::real, s.evidence,
         (select count(distinct x.link_id)::integer
            from public.link_entities x
            join public.link_entities y on y.link_id = x.link_id
           where x.entity_id = s.a and y.entity_id = s.b)
  from scored s
  join public.entities ea on ea.id = s.a
  join public.entities eb on eb.id = s.b
  where s.score >= min_score
    and not (ea.wikidata_id is not null and eb.wikidata_id is not null
             and ea.wikidata_id <> eb.wikidata_id)
  order by s.score desc, s.a, s.b
  limit max_results
$$;

revoke execute on function public.merge_proposals(integer, real) from public, anon, authenticated;
