-- Kind tree: every kind is an ltree path under 'entity'; parent must exist.
create table public.kinds (
  path ltree primary key check (subpath(path, 0, 1) = 'entity'),
  label text not null,
  description text,
  parent ltree generated always as (
    case when nlevel(path) > 1 then subpath(path, 0, nlevel(path) - 1) end
  ) stored references public.kinds(path)
);

insert into public.kinds (path, label, description) values
  ('entity', 'Entity', 'Anything tracked; unclassified entities sit here'),
  ('entity.agent', 'Agent', 'Can act: people and organizations'),
  ('entity.agent.person', 'Person', null),
  ('entity.agent.org', 'Organization', 'Legal form (e.g. cooperative) is a facet, not a kind'),
  ('entity.agent.org.company', 'Company', 'For-profit'),
  ('entity.agent.org.nonprofit', 'Nonprofit', null),
  ('entity.agent.org.public_body', 'Public body', 'Government-owned or -run'),
  ('entity.agent.org.org_unit', 'Org unit', 'Lab, department or studio inside a larger org; link with part_of'),
  ('entity.artifact', 'Artifact', 'Made things'),
  ('entity.artifact.product', 'Product', 'A product, model or technology as a type'),
  ('entity.artifact.work', 'Work', 'A specific creative or informational work'),
  ('entity.place', 'Place', null),
  ('entity.event', 'Event', null);

alter table public.kinds enable row level security;
create policy kinds_read on public.kinds for select using (true);

-- Map the legacy flat kind onto the tree.
create function public.kind_to_path(k text) returns ltree
language sql immutable set search_path = public, extensions as $$
  select case k
    when 'person'      then 'entity.agent.person'
    when 'company'     then 'entity.agent.org.company'
    when 'nonprofit'   then 'entity.agent.org.nonprofit'
    when 'public_body' then 'entity.agent.org.public_body'
    when 'cooperative' then 'entity.agent.org'
    when 'product'     then 'entity.artifact.product'
    when 'work'        then 'entity.artifact.work'
    when 'place'       then 'entity.place'
    when 'event'       then 'entity.event'
    else 'entity'
  end::ltree
$$;

alter table public.entities add column kind_path ltree references public.kinds(path);
update public.entities set kind_path = public.kind_to_path(kind);
create index entities_kind_path_gist on public.entities using gist (kind_path);

-- Keep kind_path in sync while existing writers still set the flat kind.
create function public.entities_sync_kind_path() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if new.kind_path is null
     or (tg_op = 'UPDATE' and new.kind is distinct from old.kind and new.kind_path is not distinct from old.kind_path) then
    new.kind_path := public.kind_to_path(new.kind);
  end if;
  return new;
end $$;

create trigger entities_sync_kind_path
  before insert or update of kind, kind_path on public.entities
  for each row execute function public.entities_sync_kind_path();

-- Name -> sense layer, read off the existing label witnesses.
create view public.entity_names with (security_invoker = true) as
  select value as name, entity_id, count(*)::int as witnesses, max(p) as p
  from public.identity_witnesses
  where sense = 'label'
  group by value, entity_id;
