-- Entity sense: reversible edits to the entity graph, and where places are.
--
-- 1. `entity_edits` is one log for every judged change to the graph: dropping a
--    mention that isn't one ("Tokyo" read out of "Palais de Tokyo"), merging two
--    entities that are one, or recording that two alike names are different
--    (keep) or that one is part of the other (part_of). Edits are staged,
--    reviewed, then applied one at a time by `apply_entity_edit`, which stores a
--    snapshot of every row it touched so `undo_entity_edit` can put it back.
-- 2. `entities.place_path` says where a place is, as an ltree of entity labels
--    from the outermost place in ("e12.e45.e789": France, Paris, Palais de
--    Tokyo), so "is it in Tokyo?" is one indexed `@>`, never a reading of the
--    name. `entities.wikidata_checked_at` records when an entity was last looked
--    up on Wikidata, so `place-resolve` doesn't ask twice.

-- ---------------------------------------------------------------------------
-- 1. Reversible edits
-- ---------------------------------------------------------------------------

-- One row per judged edit. `entity_id` is the entity the edit is about: the
-- mention's entity for drop_mention, the one merged away for merge, the smaller
-- one for keep/part_of. It has no foreign key, since a merge deletes it.
-- `snapshot` is written when the edit is applied. Service_role only.
create table public.entity_edits (
  id bigint generated always as identity primary key,
  batch text not null check (batch ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  op text not null check (op in ('drop_mention', 'merge', 'keep', 'part_of')),
  link_id uuid references public.links (id) on delete cascade,
  entity_id uuid not null,
  entity_name text not null,
  into_id uuid,
  into_name text,
  reason text check (char_length(reason) <= 300),
  decided_by text not null check (decided_by in ('claude', 'jev', 'manual')),
  p real check (p > 0 and p <= 1),
  status text not null default 'staged' check (status in ('staged', 'applied', 'rejected', 'undone')),
  snapshot jsonb,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  check ((op = 'drop_mention') = (link_id is not null)),
  check ((op in ('merge', 'keep', 'part_of')) = (into_id is not null)),
  check (into_id is distinct from entity_id),
  check ((status in ('applied', 'undone')) = (snapshot is not null))
);

create index entity_edits_batch_idx on public.entity_edits (batch, status);
create index entity_edits_entity_idx on public.entity_edits (entity_id);
create index entity_edits_into_idx on public.entity_edits (into_id) where into_id is not null;
-- A mention is dropped at most once while staged or applied.
create unique index entity_edits_one_drop on public.entity_edits (link_id, entity_id)
  where op = 'drop_mention' and status in ('staged', 'applied');

alter table public.entity_edits enable row level security;

-- Drops one mention: its link_entities row and the label witnesses it left.
create or replace function public.drop_mention(edit public.entity_edits)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  snap jsonb;
begin
  with gone_mention as (
    delete from public.link_entities
    where link_id = edit.link_id and entity_id = edit.entity_id
    returning *
  ), gone_witnesses as (
    delete from public.identity_witnesses
    where sense = 'label' and link_id = edit.link_id and entity_id = edit.entity_id
    returning *
  )
  select jsonb_build_object(
    'touched', jsonb_build_array(edit.entity_id::text),
    'link_entities', coalesce((select jsonb_agg(to_jsonb(m)) from gone_mention m), '[]'),
    'identity_witnesses', coalesce((select jsonb_agg(to_jsonb(w)) from gone_witnesses w), '[]')
  ) into snap;
  if jsonb_array_length(snap -> 'link_entities') = 0 then
    raise exception 'edit %: % has no mention on link %', edit.id, edit.entity_name, edit.link_id;
  end if;
  return snap;
end;
$$;

-- Folds `edit.entity_id` into `edit.into_id`: every row pointing at it is
-- repointed, rows that would then collide (a link both mention, a relation that
-- becomes a self-loop) are deleted, the old name stays as a label witness so it
-- still resolves, empty fields are filled from it, and it is deleted. The
-- snapshot lists what moved (by key) and what was deleted (whole rows).
create or replace function public.merge_entity(edit public.entity_edits)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  f uuid := edit.entity_id;
  t uuid := edit.into_id;
  tname text;
  placed jsonb;
  snap jsonb;
  moved jsonb := '{}';
  deleted jsonb := '{}';
  alias_id bigint;
begin
  if not exists (select 1 from public.entities where id = f) then
    raise exception 'edit %: entity % is gone', edit.id, edit.entity_name;
  end if;
  if not exists (select 1 from public.entities where id = t) then
    raise exception 'edit %: entity % is gone', edit.id, edit.into_name;
  end if;
  -- Merges run after any placement in flight (the same lock set_place_parent
  -- takes), and merges touching the same entities one after another, so each
  -- snapshot is taken after the previous change committed.
  perform pg_advisory_xact_lock(hashtext('public.entities.place_path'));
  perform pg_advisory_xact_lock(hashtext(least(f, t)::text));
  perform pg_advisory_xact_lock(hashtext(greatest(f, t)::text));
  tname := (select name from public.entities where id = t);
  snap := jsonb_build_object(
    'entity', (select to_jsonb(e) from public.entities e where id = f),
    'into', (select to_jsonb(e) from public.entities e where id = t),
    -- Staged edits about either entity, as they were, so undo can restore them.
    'edits', coalesce((select jsonb_agg(to_jsonb(x)) from public.entity_edits x
      where x.status = 'staged' and x.id <> edit.id and (x.entity_id in (f, t) or x.into_id in (f, t))), '[]')
  );

  -- Mentions: a link that mentions both keeps the target's row.
  with gone as (
    delete from public.link_entities m
    where m.entity_id = f
      and exists (select 1 from public.link_entities o where o.link_id = m.link_id and o.entity_id = t)
    returning m.*
  ) select coalesce(jsonb_agg(to_jsonb(g)), '[]') into deleted from gone g;
  deleted := jsonb_build_object('link_entities', deleted);
  with moved_rows as (
    update public.link_entities set entity_id = t where entity_id = f returning link_id
  ) select jsonb_build_object('link_entities', coalesce(jsonb_agg(link_id), '[]')) into moved from moved_rows;

  -- Label witnesses: the same collision rule, on (sense, value, link).
  with gone as (
    delete from public.identity_witnesses w
    where w.entity_id = f
      and exists (
        select 1 from public.identity_witnesses o
        where o.entity_id = t and o.sense = w.sense and o.value = w.value
          and o.link_id is not distinct from w.link_id)
    returning w.*
  ) select deleted || jsonb_build_object('identity_witnesses', coalesce(jsonb_agg(to_jsonb(g)), '[]'))
    into deleted from gone g;
  with moved_rows as (
    update public.identity_witnesses set entity_id = t where entity_id = f returning id
  ) select moved || jsonb_build_object('identity_witnesses', coalesce(jsonb_agg(id), '[]'))
    into moved from moved_rows;
  insert into public.identity_witnesses (sense, entity_id, value, p, labeled_by)
  select 'label', t, public.witness_label(edit.entity_name), 1, 'merge'
  where public.witness_label(edit.entity_name) is not null
    and char_length(public.witness_label(edit.entity_name)) <= 300
  on conflict do nothing
  returning id into alias_id;

  -- Relations: a claim between the two becomes a self-loop and goes.
  with gone as (
    delete from public.entity_relations
    where (subject_id = f and object_id = t) or (subject_id = t and object_id = f) or (subject_id = f and object_id = f)
    returning *
  ) select deleted || jsonb_build_object('entity_relations', coalesce(jsonb_agg(to_jsonb(g)), '[]'))
    into deleted from gone g;
  with moved_rows as (
    update public.entity_relations set subject_id = t where subject_id = f returning id
  ) select moved || jsonb_build_object('relation_subjects', coalesce(jsonb_agg(id), '[]')) into moved from moved_rows;
  with moved_rows as (
    update public.entity_relations set object_id = t where object_id = f returning id
  ) select moved || jsonb_build_object('relation_objects', coalesce(jsonb_agg(id), '[]')) into moved from moved_rows;

  with moved_rows as (
    update public.entity_properties set entity_id = t where entity_id = f returning id
  ) select moved || jsonb_build_object('entity_properties', coalesce(jsonb_agg(id), '[]')) into moved from moved_rows;
  with moved_rows as (
    update public.link_events set venue_entity_id = t where venue_entity_id = f returning id
  ) select moved || jsonb_build_object('link_events', coalesce(jsonb_agg(id), '[]')) into moved from moved_rows;
  with moved_rows as (
    update public.sources set entity_id = t where entity_id = f returning id
  ) select moved || jsonb_build_object('sources', coalesce(jsonb_agg(id), '[]')) into moved from moved_rows;

  -- Place paths: every path this merge may change is recorded first. A target
  -- not placed anywhere takes the merged-away entity's parent; places inside
  -- the merged-away one move inside the target, keeping the rest of their path.
  if public.place_self(t) operator(extensions.<@) public.place_self(f) then
    raise exception 'edit %: % lies inside %; place it elsewhere first', edit.id, tname, edit.entity_name;
  end if;
  if exists (select 1 from public.entities c where c.id <> f and c.place_path operator(extensions.<@) public.place_self(f))
     and not exists (select 1 from public.entities e where e.id = t and e.kind_path operator(extensions.<@) 'entity.place'::extensions.ltree) then
    raise exception 'edit %: places lie inside %, but % is not a place', edit.id, edit.entity_name, tname;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'path', c.place_path::text, 'by', c.place_labeled_by)), '[]')
  into placed
  from public.entities c
  where c.id <> f and (c.id = t
    or c.place_path operator(extensions.<@) public.place_self(f)
    or c.place_path operator(extensions.<@) public.place_self(t));
  if (select place_path is null from public.entities where id = t) and public.place_parent(f) is not null then
    perform public.set_place_parent(t, public.place_parent(f), (snap -> 'entity' ->> 'place_labeled_by'));
  end if;
  update public.entities c
  set place_path = public.place_self(t) operator(extensions.||)
    extensions.subpath(c.place_path, extensions.nlevel(public.place_self(f)))
  where c.id <> f and c.place_path operator(extensions.<@) public.place_self(f);
  moved := moved || jsonb_build_object('place_paths', placed);
  -- The target's place and everything inside it as left by this merge: undo
  -- refuses if a later placement changed them.
  snap := snap || jsonb_build_object('places_after', public.place_subtree(t));

  delete from public.entities where id = f;
  update public.entities keep
  set nace_code = coalesce(keep.nace_code, (snap -> 'entity' ->> 'nace_code')),
      country = coalesce(keep.country, (snap -> 'entity' ->> 'country')),
      website = coalesce(keep.website, (snap -> 'entity' ->> 'website')),
      description = coalesce(keep.description, (snap -> 'entity' ->> 'description')),
      wikidata_id = coalesce(keep.wikidata_id, (snap -> 'entity' ->> 'wikidata_id'))
  where keep.id = t;

  -- Staged edits between the two, or dropping one of its mentions (which may
  -- now be the target's), are superseded; other staged edits about it now mean
  -- the target.
  update public.entity_edits set status = 'rejected', reason = left(coalesce(reason || ' ', '') || '[superseded by edit ' || edit.id || ']', 300)
  where status = 'staged' and id <> edit.id
    and ((entity_id = f and into_id = t) or (entity_id = t and into_id = f) or (op = 'drop_mention' and entity_id = f));
  update public.entity_edits set entity_id = t, entity_name = tname
  where status = 'staged' and id <> edit.id and entity_id = f;
  update public.entity_edits set into_id = t, into_name = tname
  where status = 'staged' and id <> edit.id and into_id = f;

  return snap || jsonb_build_object(
    'moved', moved, 'deleted', deleted, 'alias_witness', alias_id,
    -- Every entity whose rows this merge changed, for undo's ordering check.
    'touched', (select jsonb_agg(distinct x) from (
      select f::text x union select t::text union select p ->> 'id' from jsonb_array_elements(placed) p
      union select e ->> 'entity_id' from jsonb_array_elements(snap -> 'edits') e
      union select e ->> 'into_id' from jsonb_array_elements(snap -> 'edits') e where e ->> 'into_id' is not null) u));
end;
$$;

-- Applies one staged edit and records its snapshot. keep and part_of change no
-- rows: they are a record that the pair was judged, so it isn't asked again.
create or replace function public.apply_entity_edit(edit_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  edit public.entity_edits;
  snap jsonb;
begin
  select * into edit from public.entity_edits where id = edit_id for update;
  if not found then raise exception 'no edit %', edit_id; end if;
  if edit.status <> 'staged' then raise exception 'edit % is %, not staged', edit_id, edit.status; end if;
  snap := case edit.op
    when 'drop_mention' then public.drop_mention(edit)
    when 'merge' then public.merge_entity(edit)
    else '{}'::jsonb
  end;
  -- clock_timestamp, not now(): edits applied in one transaction stay in order.
  update public.entity_edits set status = 'applied', applied_at = clock_timestamp(), snapshot = snap where id = edit_id;
  return jsonb_build_object('edit', edit_id, 'op', edit.op, 'entity', edit.entity_name, 'into', edit.into_name);
end;
$$;

-- Puts an applied edit's rows back as they were.
create or replace function public.undo_entity_edit(edit_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  edit public.entity_edits;
  s jsonb;
  f uuid;
  t uuid;
begin
  select * into edit from public.entity_edits where id = edit_id for update;
  if not found then raise exception 'no edit %', edit_id; end if;
  if edit.status <> 'applied' then raise exception 'edit % is %, not applied', edit_id, edit.status; end if;
  s := edit.snapshot;
  f := edit.entity_id;
  t := edit.into_id;
  -- Undo in reverse order: a later applied edit about the same entities (or,
  -- for a drop, the same mention) may rest on this one's rows.
  if exists (
    select 1 from public.entity_edits later
    where later.status = 'applied' and (later.applied_at, later.id) > (edit.applied_at, edit.id)
      and (later.entity_id::text in (select jsonb_array_elements_text(s -> 'touched'))
        or later.into_id::text in (select jsonb_array_elements_text(s -> 'touched'))
        or coalesce(later.snapshot -> 'touched', '[]') ?| array(select jsonb_array_elements_text(s -> 'touched')))
  ) then
    raise exception 'edit %: undo the later applied edits about % first', edit_id, edit.entity_name;
  end if;

  if edit.op = 'drop_mention' then
    -- Witnesses first, so the mention's insert trigger finds its label already back.
    insert into public.identity_witnesses overriding system value
    select * from jsonb_populate_recordset(null::public.identity_witnesses, s -> 'identity_witnesses')
    on conflict do nothing;
    insert into public.link_entities overriding system value
    select * from jsonb_populate_recordset(null::public.link_entities, s -> 'link_entities');
  elsif edit.op = 'merge' then
    if public.place_subtree(t) is distinct from coalesce(s -> 'places_after', public.place_subtree(t)) then
      raise exception 'edit %: places in or around % changed since; move them back first', edit_id, edit.into_name;
    end if;
    -- The target first gives back what it took (a unique wikidata_id among it),
    -- then the merged-away entity returns.
    update public.entities e set
      nace_code = (s -> 'into' ->> 'nace_code'), country = (s -> 'into' ->> 'country'),
      website = (s -> 'into' ->> 'website'), description = (s -> 'into' ->> 'description'),
      wikidata_id = (s -> 'into' ->> 'wikidata_id')
    where e.id = t;
    insert into public.entities overriding system value
    select * from jsonb_populate_record(null::public.entities, s -> 'entity');
    update public.link_entities set entity_id = f
    where entity_id = t and link_id in (select jsonb_array_elements_text(s -> 'moved' -> 'link_entities')::uuid);
    update public.identity_witnesses set entity_id = f
    where id in (select jsonb_array_elements_text(s -> 'moved' -> 'identity_witnesses')::bigint);
    delete from public.identity_witnesses where id = (s ->> 'alias_witness')::bigint;
    update public.entity_relations set subject_id = f
    where id in (select jsonb_array_elements_text(s -> 'moved' -> 'relation_subjects')::uuid);
    update public.entity_relations set object_id = f
    where id in (select jsonb_array_elements_text(s -> 'moved' -> 'relation_objects')::uuid);
    update public.entity_properties set entity_id = f
    where id in (select jsonb_array_elements_text(s -> 'moved' -> 'entity_properties')::uuid);
    update public.link_events set venue_entity_id = f
    where id in (select jsonb_array_elements_text(s -> 'moved' -> 'link_events')::uuid);
    update public.sources set entity_id = f
    where id in (select jsonb_array_elements_text(s -> 'moved' -> 'sources')::uuid);
    update public.entities c set place_path = (o ->> 'path')::extensions.ltree, place_labeled_by = o ->> 'by'
    from jsonb_array_elements(s -> 'moved' -> 'place_paths') o
    where c.id = (o ->> 'id')::uuid;
    insert into public.identity_witnesses overriding system value
    select * from jsonb_populate_recordset(null::public.identity_witnesses, s -> 'deleted' -> 'identity_witnesses')
    on conflict do nothing;
    insert into public.link_entities overriding system value
    select * from jsonb_populate_recordset(null::public.link_entities, s -> 'deleted' -> 'link_entities');
    insert into public.entity_relations
    select * from jsonb_populate_recordset(null::public.entity_relations, s -> 'deleted' -> 'entity_relations');
    -- Staged edits it superseded or retargeted go back to how they were, unless
    -- they have been decided since.
    update public.entity_edits x set
      entity_id = o.entity_id, entity_name = o.entity_name, into_id = o.into_id,
      into_name = o.into_name, reason = o.reason, status = o.status
    from jsonb_populate_recordset(null::public.entity_edits, s -> 'edits') o
    where x.id = o.id and (x.status = 'staged' or (x.status = 'rejected' and o.status = 'staged'));
  end if;

  -- Restored rows keep their old seq, below what readers' index copies already
  -- hold, so a new index generation makes them reload.
  if edit.op in ('drop_mention', 'merge') then
    update public.index_state set gen = gen + 1 where id;
  end if;
  update public.entity_edits set status = 'undone' where id = edit_id;
  return jsonb_build_object('edit', edit_id, 'op', edit.op, 'undone', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Where places are
-- ---------------------------------------------------------------------------

-- Where a place is: the labels of the places it is in, outermost first, then
-- its own ("e" and its seq, since uuids aren't ltree labels). Null until it is
-- placed. "Palais de Tokyo" is under Paris, not Tokyo: its name says nothing.
-- `place_labeled_by` says who placed it. Whether it was looked up on Wikidata,
-- and how sure the pick was (null when no item fit), is `wikidata_checked_at`
-- and `wikidata_p`. Written only through `set_place_parent` and place-resolve.
alter table public.entities
  add column place_path extensions.ltree,
  add column place_labeled_by text check (place_labeled_by in ('wikidata', 'jev', 'manual')),
  add column wikidata_checked_at timestamptz,
  add column wikidata_p real check (wikidata_p > 0 and wikidata_p <= 1),
  add constraint entities_placed_by check ((place_path is null) = (place_labeled_by is null));

create index entities_place_path_gist on public.entities using gist (place_path);

-- An entity's own ltree label, and its path or, unplaced, that label alone.
create or replace function public.place_label(entity uuid)
returns extensions.ltree language sql stable set search_path = '' as $$
  select ('e' || seq)::extensions.ltree from public.entities where id = entity
$$;

create or replace function public.place_self(entity uuid)
returns extensions.ltree language sql stable set search_path = '' as $$
  select coalesce(place_path, ('e' || seq)::extensions.ltree) from public.entities where id = entity
$$;

-- `entity`'s own path and those of every place inside it, sorted, as jsonb.
create or replace function public.place_subtree(entity uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(c.id, c.place_path::text) order by c.id), '[]')
  from public.entities c
  where c.id = entity or c.place_path operator(extensions.<@) public.place_self(entity)
$$;

-- The place `entity` is directly in, or null.
create or replace function public.place_parent(entity uuid)
returns uuid language sql stable set search_path = '' as $$
  select a.id from public.entities e
  join public.entities a on ('e' || a.seq) = extensions.subpath(e.place_path, extensions.nlevel(e.place_path) - 2, 1)::text
  where e.id = entity and extensions.nlevel(e.place_path) > 1
$$;

-- The places `entity` is in, nearest first (depth 1 is its parent).
create or replace function public.place_ancestors(entity uuid)
returns table (id uuid, name text, depth integer)
language sql
stable
set search_path = ''
as $$
  select a.id, a.name, extensions.nlevel(e.place_path) - 1 - i.n
  from public.entities e
  cross join lateral generate_series(0, extensions.nlevel(e.place_path) - 2) as i(n)
  join public.entities a on ('e' || a.seq) = extensions.subpath(e.place_path, i.n, 1)::text
  where e.id = entity
  order by 3
$$;

-- Whether `place` is `container` or somewhere inside it.
create or replace function public.place_within(place uuid, container uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.place_self(container) operator(extensions.@>) public.place_self(place), false)
$$;

-- Puts `entity` (and everything inside it) inside `parent`, a place. A parent
-- already inside `entity` would make a cycle and is refused. Writers take one
-- lock, so two can't each move half of a cycle from stale paths.
create or replace function public.set_place_parent(entity uuid, parent uuid, labeled_by text)
returns extensions.ltree
language plpgsql
set search_path = ''
as $$
declare
  old_self extensions.ltree;
  new_self extensions.ltree;
begin
  perform pg_advisory_xact_lock(hashtext('public.entities.place_path'));
  if not exists (
    select 1 from public.entities e
    where e.id = parent and e.kind_path operator(extensions.<@) 'entity.place'::extensions.ltree
  ) then
    raise exception 'parent % of % is not a place', parent, entity;
  end if;
  old_self := public.place_self(entity);
  if old_self is null then raise exception 'no entity %', entity; end if;
  if public.place_self(parent) operator(extensions.<@) old_self then
    raise exception 'placing % in % would make a cycle', entity, parent;
  end if;
  new_self := public.place_self(parent) operator(extensions.||) public.place_label(entity);
  update public.entities set place_path = new_self, place_labeled_by = labeled_by where id = entity;
  update public.entities c
  set place_path = new_self operator(extensions.||) extensions.subpath(c.place_path, extensions.nlevel(old_self))
  where c.id <> entity and c.place_path operator(extensions.<@) old_self;
  return new_self;
end;
$$;

-- The next places to look up on Wikidata: never looked up, most mentioned first.
create or replace function public.places_to_resolve(max_results integer)
returns table (id uuid, name text, mentions integer)
language sql
stable
set search_path = ''
as $$
  select e.id, e.name, count(m.link_id)::int
  from public.entities e
  left join public.link_entities m on m.entity_id = e.id
  where e.kind_path operator(extensions.<@) 'entity.place'::extensions.ltree
    and e.wikidata_checked_at is null
  group by e.id
  order by count(m.link_id) desc, e.created_at
  limit max_results
$$;

-- A merged-away name stays findable: entity_candidates also scores the label
-- witnesses a merge keeps (labeled_by 'merge'), not only names and surfaces.
create or replace function public.entity_candidates(phrase text, max_results integer default 8)
returns table(id uuid, name text, kind text, description text, example_title text, similarity real)
language sql stable set search_path = public, extensions as $$
  with scored as (
    select e.id, greatest(
      similarity(lower(e.name), lower(phrase)),
      coalesce((select max(similarity(lower(m.surface), lower(phrase)))
                from link_entities m where m.entity_id = e.id and m.surface is not null), 0),
      coalesce((select max(similarity(w.value, lower(phrase)))
                from identity_witnesses w
                where w.entity_id = e.id and w.sense = 'label' and w.labeled_by = 'merge'), 0)
    ) as similarity
    from entities e
    where e.kind <> 'source'
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

revoke execute on function public.drop_mention(public.entity_edits) from public, anon, authenticated;
revoke execute on function public.merge_entity(public.entity_edits) from public, anon, authenticated;
revoke execute on function public.apply_entity_edit(bigint) from public, anon, authenticated;
revoke execute on function public.undo_entity_edit(bigint) from public, anon, authenticated;
revoke execute on function public.places_to_resolve(integer) from public, anon, authenticated;
revoke execute on function public.set_place_parent(uuid, uuid, text) from public, anon, authenticated;
