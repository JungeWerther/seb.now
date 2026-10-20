-- The part of production's schema the style-types migration touches, as it is
-- before that migration: tables, constraints, triggers and grants. Runs as
-- postgres in a fresh database on Supabase's own Postgres image, whose roles are
-- cluster-wide; what Supabase sets up per database comes first.
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create extension if not exists ltree with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
set search_path = public, extensions;

create function public.fold_text(t text) returns text language sql immutable
  set search_path = public, extensions as $$ select lower(unaccent(t)) $$;
create function public.name_first_word(name text) returns text language sql immutable
  as $$ select lower(split_part(name, ' ', 1)) $$;

create table public.kinds (
  path ltree primary key check (subpath(path, 0, 1) = 'entity'),
  label text not null,
  description text,
  parent ltree generated always as (
    case when nlevel(path) > 1 then subpath(path, 0, nlevel(path) - 1) end
  ) stored references public.kinds(path)
);
alter table public.kinds enable row level security;
create policy kinds_read on public.kinds for select using (true);
grant all on public.kinds to anon, authenticated;
insert into public.kinds (path, label) values
  ('entity', 'Entity'), ('entity.agent', 'Agent'), ('entity.agent.org', 'Organization'),
  ('entity.agent.org.company', 'Company'), ('entity.place', 'Place'), ('entity.source', 'Source');

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  country text check (country ~ '^[A-Z]{2}$'),
  description text,
  created_at timestamptz not null default now(),
  kind_path ltree references public.kinds(path),
  seq bigint generated always as identity,
  constraint entities_kind_check check (kind = any (array[
    'company', 'cooperative', 'nonprofit', 'public_body', 'person', 'product', 'place', 'event', 'work', 'other',
    'source'
  ]))
);
create unique index entities_name_kind_key on public.entities (lower(name), kind_path);
alter table public.entities enable row level security;
create policy "entities are publicly readable" on public.entities for select to anon, authenticated using (true);
revoke all on public.entities from anon, authenticated;
grant select, references, trigger on public.entities to anon, authenticated;

create function public.kind_to_path(k text) returns ltree language sql immutable as $$
  select case k when 'company' then 'entity.agent.org.company' when 'place' then 'entity.place'
    when 'source' then 'entity.source' else 'entity' end::ltree
$$;
create function public.entities_sync_kind_path() returns trigger language plpgsql as $$
begin
  if new.kind_path is null
     or (tg_op = 'UPDATE' and new.kind is distinct from old.kind and new.kind_path is not distinct from old.kind_path) then
    new.kind_path := public.kind_to_path(new.kind);
  end if;
  return new;
end $$;
create trigger entities_sync_kind_path before insert or update of kind, kind_path on public.entities
  for each row execute function public.entities_sync_kind_path();

create table public.identity_witnesses (
  id uuid primary key default gen_random_uuid(),
  sense text not null,
  entity_id uuid not null references public.entities(id) on delete cascade,
  link_id uuid,
  value text not null,
  p real not null,
  labeled_by text not null,
  unique (sense, entity_id, value)
);
alter table public.identity_witnesses enable row level security;
create function public.entities_add_kind_witness() returns trigger language plpgsql as $$
begin
  insert into public.identity_witnesses (sense, entity_id, value, p, labeled_by)
  values ('kind', new.id, new.kind, 1, 'entities.kind')
  on conflict do nothing;
  return new;
end $$;
create trigger entities_add_kind_witness after insert on public.entities
  for each row execute function public.entities_add_kind_witness();

create table public.links (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  title text not null default '',
  created_at timestamptz not null default now()
);
create table public.link_entities (
  link_id uuid references public.links(id) on delete cascade,
  entity_id uuid references public.entities(id) on delete cascade,
  surface text,
  p real not null default 1,
  created_at timestamptz not null default now(),
  primary key (link_id, entity_id)
);

create table public.index_state (id boolean primary key default true check (id), gen bigint not null default 0);
insert into public.index_state default values;
create table public.index_changes (
  seq bigint generated always as identity primary key,
  link_seq bigint,
  entity_seq bigint
);
create function public.index_change_bump() returns void language plpgsql security definer set search_path = public as $$
begin
  update index_state set gen = gen + 1 where id;
end $$;
create function public.index_log_entity_deleted() returns trigger language plpgsql security definer
  set search_path = public as $$
begin
  if not exists (select 1 from gone) then return null; end if;
  perform index_change_bump();
  insert into index_changes (entity_seq) select seq from gone;
  return null;
end $$;
create trigger entities_deleted_logs_index after delete on public.entities
  referencing old table as gone for each statement execute function public.index_log_entity_deleted();

insert into public.entities (name, kind) values ('Dark Matter Labs', 'company');
