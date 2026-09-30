-- Entities beyond organisations, and link_entities as extracted mentions.
-- The entity-extract function (Jev) adds people, products, places, events and
-- works alongside the NACE-classified organisations; nace_code stays optional
-- and meaningful for organisations only.
alter table public.entities drop constraint entities_kind_check;
alter table public.entities add constraint entities_kind_check
  check (kind in (
    'company', 'cooperative', 'nonprofit', 'public_body',
    'person', 'product', 'place', 'event', 'work', 'other'
  ));

-- A mention keeps the text as it appeared (`surface`, e.g. "Cerebras Systems’");
-- an entity's surfaces double as its aliases when matching new mentions. p is how
-- sure the extractor was; labeled_by separates hand links from Jev's. Existing
-- hand links keep working unchanged: surface may be null, p and labeled_by default.
alter table public.link_entities
  add column surface text check (char_length(surface) between 1 and 200),
  add column p real not null default 1 check (p > 0 and p <= 1),
  add column labeled_by text not null default 'manual' check (labeled_by in ('manual', 'jev')),
  add column created_at timestamptz not null default now();

create index entities_name_trgm_idx on public.entities using gin (lower(name) extensions.gin_trgm_ops);
create index link_entities_surface_trgm_idx
  on public.link_entities using gin (lower(surface) extensions.gin_trgm_ops);

-- link_enrichment: when each automatic step last ran on a link, so a link that
-- yielded nothing isn't picked up again on every run. service_role only.
create table public.link_enrichment (
  link_id uuid primary key references public.links (id) on delete cascade,
  topics_at timestamptz,
  entities_at timestamptz
);

alter table public.link_enrichment enable row level security;

-- entity_candidates: existing entities whose name, or any text they were
-- mentioned as, is close to `phrase` (trigram similarity), best first, each with
-- one title it was mentioned in so a classifier can tell namesakes apart.
-- Scans every entity: fine at hundreds, needs the trigram indexes' operators
-- (`%`) before tens of thousands.
create function public.entity_candidates(phrase text, max_results integer default 8)
returns table (id uuid, name text, kind text, description text, example_title text, similarity real)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with scored as (
    select e.id, greatest(
      similarity(lower(e.name), lower(phrase)),
      coalesce((select max(similarity(lower(m.surface), lower(phrase)))
                from link_entities m where m.entity_id = e.id and m.surface is not null), 0)
    ) as similarity
    from entities e
  )
  select e.id, e.name, e.kind, e.description,
    (select l.title from link_entities m join links l on l.id = m.link_id
     where m.entity_id = e.id order by m.created_at limit 1),
    s.similarity
  from scored s join entities e on e.id = s.id
  where s.similarity >= 0.3
  order by s.similarity desc, e.created_at
  limit max_results
$$;
