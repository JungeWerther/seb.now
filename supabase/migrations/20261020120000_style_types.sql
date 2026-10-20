-- Style types: design tokens (CSS custom properties) in the entity graph.
-- A style type is a kind `entity.style.<name>` whose `schema` is JSON Schema;
-- a style is an entity of that kind whose `style` holds the token values.
-- Readers may add types and styles of their own (RLS: owner writes, everyone
-- reads). A type's schema may only name primitives from `style_primitives`, so
-- the CSS-safety rules live in our patterns, never in an uploaded one, and
-- pg_jsonschema checks every value in the database itself.

create extension if not exists pg_jsonschema with schema extensions;

create table public.style_primitives (
  name text primary key check (name ~ '^[a-z]{2,16}$'),
  schema jsonb not null,
  description text not null
);
alter table public.style_primitives enable row level security;
create policy "style primitives are publicly readable" on public.style_primitives
  for select to anon, authenticated using (true);
revoke all on public.style_primitives from anon, authenticated;
grant select on public.style_primitives to anon, authenticated;

-- No value can hold `(`, `;`, `{`, `}`, `\` or `<`, so none can be url(),
-- expression(), or close a declaration or a <style>.
insert into public.style_primitives (name, schema, description) values
  ('color', '{"type": "string", "pattern": "^#[0-9a-f]{6}([0-9a-f]{2})?$"}', 'A hex colour, #rrggbb or #rrggbbaa'),
  ('length', '{"type": "string", "pattern": "^(0|[0-9]{1,4}(\\.[0-9]{1,3})?(px|rem|em|vw|vh|%))$"}',
    'A CSS length: 0, or a number with px, rem, em, vw, vh or %'),
  ('duration', '{"type": "string", "pattern": "^[0-9]{1,5}(ms|s)$"}', 'A CSS time in ms or s'),
  ('number', '{"type": "number", "minimum": -10000, "maximum": 10000}', 'A plain number'),
  ('font', '{"type": "string", "pattern": "^[A-Za-z0-9 ,\"-]{1,120}$"}',
    'A font-family list: names, quotes, commas and hyphens');

create function public.style_types_per_user() returns integer language sql immutable as $$ select 10 $$;
create function public.styles_per_user() returns integer language sql immutable as $$ select 50 $$;

-- What a reader may upload as a type's schema: named properties, each one of
-- our primitives or a short enum of keywords. Nothing else is accepted (no
-- `pattern`, no `$ref` outside our `$defs`, no nesting).
create function public.style_meta_schema()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'type', 'object',
    'additionalProperties', false,
    'required', jsonb_build_array('properties'),
    'properties', jsonb_build_object(
      'properties', jsonb_build_object(
        'type', 'object',
        'minProperties', 1,
        'maxProperties', 64,
        'propertyNames', jsonb_build_object('pattern', '^[a-z][a-z0-9_]{0,31}$'),
        'additionalProperties', jsonb_build_object('oneOf', jsonb_build_array(
          jsonb_build_object(
            'type', 'object',
            'additionalProperties', false,
            'required', jsonb_build_array('$ref'),
            'properties', jsonb_build_object(
              '$ref', jsonb_build_object('enum', (select jsonb_agg('#/$defs/' || name order by name) from style_primitives)),
              'description', jsonb_build_object('type', 'string', 'maxLength', 200)
            )
          ),
          jsonb_build_object(
            'type', 'object',
            'additionalProperties', false,
            'required', jsonb_build_array('enum'),
            'properties', jsonb_build_object(
              'enum', jsonb_build_object(
                'type', 'array', 'minItems', 1, 'maxItems', 16, 'uniqueItems', true,
                'items', jsonb_build_object('type', 'string', 'pattern', '^[a-z0-9-]{1,32}$')
              ),
              'description', jsonb_build_object('type', 'string', 'maxLength', 200)
            )
          )
        ))
      )
    )
  )
$$;

-- The self-contained schema a type is stored as: every declared token
-- required, nothing undeclared, our primitives inlined as `$defs`.
create function public.style_type_schema(declared jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'type', 'object',
    'additionalProperties', false,
    'properties', declared -> 'properties',
    'required', (select jsonb_agg(k order by k) from jsonb_object_keys(declared -> 'properties') k),
    '$defs', (select jsonb_object_agg(name, schema) from style_primitives)
  )
$$;

alter table public.kinds
  add column schema jsonb,
  add column owner_id uuid references auth.users (id) on delete set null,
  add constraint kinds_style_schema check ((schema is not null) = (path <@ 'entity.style' and nlevel(path) = 3));
alter table public.kinds alter column owner_id set default auth.uid();

create function public.kinds_compile_style_schema()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'UPDATE' then
    if new.schema is distinct from old.schema then
      raise exception 'a style type''s schema can''t change; add a new type' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not (new.path <@ 'entity.style' and nlevel(new.path) = 3) then
    return new;
  end if;
  if new.schema is null or not jsonb_matches_schema(style_meta_schema()::json, new.schema) then
    raise exception 'style type % needs a schema of named primitives or enums', new.path using errcode = 'check_violation';
  end if;
  if new.label !~ '^[A-Za-z0-9 ]{2,40}$' or char_length(coalesce(new.description, '')) > 500 then
    raise exception 'style type labels are 2-40 letters, digits or spaces' using errcode = 'check_violation';
  end if;
  if new.owner_id is not null then
    perform pg_advisory_xact_lock(hashtext('style_types'), hashtext(new.owner_id::text));
  end if;
  if new.owner_id is not null
     and (select count(*) from kinds where owner_id = new.owner_id) >= style_types_per_user() then
    raise exception 'at most % style types per user', style_types_per_user() using errcode = 'check_violation';
  end if;
  new.schema := style_type_schema(new.schema);
  return new;
end
$$;

create trigger kinds_compile_style_schema before insert or update of schema on public.kinds
  for each row execute function public.kinds_compile_style_schema();

insert into public.kinds (path, label, description) values
  ('entity.style', 'Style', 'A set of design tokens (CSS custom properties) the page can apply');

-- Writes to kinds were only held back by RLS; truncate isn't, so it goes too.
revoke insert, update, delete, truncate on public.kinds from anon, authenticated;
grant insert (path, label, description, schema) on public.kinds to authenticated;
grant delete on public.kinds to authenticated;
create policy "Users add their own style types" on public.kinds
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and path <@ 'entity.style' and nlevel(path) = 3);
create policy "Users remove their own style types" on public.kinds
  for delete to authenticated
  using (owner_id = (select auth.uid()));

alter table public.entities drop constraint entities_kind_check;
alter table public.entities add constraint entities_kind_check check (kind = any (array[
  'company', 'cooperative', 'nonprofit', 'public_body', 'person', 'product', 'place', 'event', 'work', 'other',
  'source', 'style'
]));
alter table public.entities
  add column style jsonb,
  add column owner_id uuid references auth.users (id) on delete cascade;
alter table public.entities alter column owner_id set default auth.uid();

-- Counts run under a per-owner lock, so concurrent inserts can't both pass a
-- quota. Named to sort before entities_sync_kind_path, so `kind` is set before that
-- trigger would derive a kind_path from it.
create function public.entities_check_style()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  type_schema jsonb;
begin
  select schema into type_schema from kinds where path = new.kind_path;
  if type_schema is null then
    if new.style is not null or new.kind = 'style' then
      raise exception 'only entities of a style type are styles' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.style is null or not jsonb_matches_schema(type_schema::json, new.style) then
    raise exception 'style doesn''t match the schema of %', new.kind_path using errcode = 'check_violation';
  end if;
  new.kind := 'style';
  if tg_op = 'INSERT' and new.owner_id is not null then
    perform pg_advisory_xact_lock(hashtext('styles'), hashtext(new.owner_id::text));
  end if;
  if tg_op = 'INSERT' and new.owner_id is not null
     and (select count(*) from entities where owner_id = new.owner_id) >= styles_per_user() then
    raise exception 'at most % styles per user', styles_per_user() using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger entities_check_style before insert or update of style, kind_path, kind on public.entities
  for each row execute function public.entities_check_style();

grant insert (name, kind, kind_path, description, style) on public.entities to authenticated;
grant update (description, style) on public.entities to authenticated;
grant delete on public.entities to authenticated;
create policy "Users add their own styles" on public.entities
  for insert to authenticated
  with check (
    owner_id = (select auth.uid()) and kind_path <@ 'entity.style' and nlevel(kind_path) = 3
    and char_length(name) between 1 and 60 and char_length(coalesce(description, '')) <= 500
  );
create policy "Users change their own styles" on public.entities
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and char_length(coalesce(description, '')) <= 500);
create policy "Users remove their own styles" on public.entities
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Styles are no one's name for anything: kept out of identity witnesses, the
-- entity index's change log and name resolution, like sources are.
-- entities_add_kind_witness predates the migration history, so it's only
-- narrowed where it exists.
do $$
begin
  if to_regprocedure('public.entities_add_kind_witness()') is not null then
    drop trigger if exists entities_add_kind_witness on public.entities;
    create trigger entities_add_kind_witness after insert on public.entities
      for each row when (new.kind <> 'style') execute function public.entities_add_kind_witness();
  end if;
end
$$;

create or replace function public.index_log_entity_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from gone where kind <> 'style') then return null; end if;
  perform index_change_bump();
  insert into index_changes (entity_seq) select seq from gone where kind <> 'style';
  return null;
end
$$;

-- A function may only SET pg_trgm.similarity_threshold once pg_trgm is loaded.
select extensions.show_limit();

create or replace function public.entity_candidates(phrase text, max_results integer default 8)
returns table(id uuid, name text, kind text, description text, example_title text, similarity real)
language sql
stable
set search_path = public, extensions
set pg_trgm.similarity_threshold = '0.3'
as $$
  with hits as (
    select e.id, similarity(lower(e.name), lower(phrase)) as similarity
    from entities e
    where lower(e.name) % lower(phrase) and e.kind not in ('source', 'style')
    union all
    select m.entity_id, similarity(lower(m.surface), lower(phrase))
    from link_entities m join entities e on e.id = m.entity_id
    where lower(m.surface) % lower(phrase) and e.kind not in ('source', 'style')
    union all
    select w.entity_id, similarity(w.value, lower(phrase))
    from identity_witnesses w join entities e on e.id = w.entity_id
    where w.sense = 'label' and (w.link_id is null or w.labeled_by = 'merge')
      and w.value % lower(phrase) and e.kind not in ('source', 'style')
  ), scored as (
    select h.id, max(h.similarity) as similarity from hits h group by h.id
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

create or replace function public.known_names(first_words text[], max_results integer default 3000)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(name), '{}')
  from (
    select e.name
    from public.entities e
    where public.name_first_word(e.name) = any(first_words)
      and length(e.name) >= 3
      and e.kind not in ('source', 'style')
    limit max_results
  ) t
$$;

create or replace function public.match_entities(words text[], partial text default null, max_results integer default 4)
returns table(id uuid, name text, kind text, posts bigint)
language sql
stable
set search_path = public, extensions
as $$
  with typed as (
    select w, false as is_partial
    from (select regexp_replace(lower(w), '[^a-z0-9]', '', 'g') as w from unnest(words[1:12]) w) t
    where w <> ''
    union all
    select regexp_replace(lower(partial), '[^a-z0-9]', '', 'g'), true
    where length(regexp_replace(lower(coalesce(partial, '')), '[^a-z0-9]', '', 'g')) >= 2
  ),
  candidates as (
    select distinct e.id, e.name, e.kind
    from typed t
    join entities e on fold_text(e.name) like '%' || t.w || '%'
    where length(t.w) >= 3 and e.kind <> 'style'
    union
    select e.id, e.name, e.kind
    from typed t
    join entities e on fold_text(e.name) = t.w or fold_text(e.name) like t.w || ' %'
    where length(t.w) < 3 and e.kind <> 'style'
  ),
  scored as (
    select c.id, c.name, c.kind, cardinality(nw.words) as n,
      (select count(*) from unnest(nw.words) x
        where exists (
          select 1 from typed t
          where x = t.w
            or (t.is_partial and x like t.w || '%')
            or (length(t.w) >= 3 and (x in (t.w || 's', t.w || 'es') or t.w in (x || 's', x || 'es')))
        )) as hits
    from candidates c,
    lateral (
      select array(
        select x from regexp_split_to_table(lower(unaccent(c.name)), '[^a-z0-9]+') x
        where x <> '' and x <> all (array['a', 'an', 'and', 'the', 'of', 'on', 'in', 'for', 'to', 'at', 'by',
          'with', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'y', 'el', 'von', 'van', 'der', 'den'])
      ) as words
    ) nw
  )
  select s.id, s.name, s.kind, (select count(*) from link_entities le where le.entity_id = s.id) as posts
  from scored s
  where s.n > 0 and s.hits * 2 >= s.n
  order by s.hits::float / s.n desc, posts desc, length(s.name), s.id
  limit least(max_results, 10)
$$;

-- The page's own layout, as the first type and its built-in style.
insert into public.kinds (path, label, description, schema) values (
  'entity.style.layout', 'Layout', 'Widths of the page''s columns',
  '{"properties": {
    "column_width": {"$ref": "#/$defs/length", "description": "The feed column"},
    "dock_width": {"$ref": "#/$defs/length", "description": "The search bar and reply composer"}
  }}'
);
insert into public.entities (name, kind, kind_path, description, style) values (
  'seb.now layout', 'style', 'entity.style.layout', 'The site''s default layout',
  '{"column_width": "720px", "dock_width": "480px"}'
);
