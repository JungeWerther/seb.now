-- Undoing a merge refuses when what it would restore no longer fits.
--
-- `undo_entity_edit` already refuses while a later applied edit touched the
-- same entities, or while the kept entity's own subtree changed. Two changes
-- made outside `entity_edits` slipped past both:
--
-- 1. A place the merged-away entity was in, moved since by `set_place_parent`
--    (A in P merged into B in an unrelated Q, then P put under R): restoring A
--    at its saved path `eP.eA` would leave it under a P whose own path is now
--    `eR.eP`, so `place_parent(A)` is P while `place_within(A, P)` is false.
--    Every path undo restores must still resolve: each place it names must
--    exist, and its own current path must be that path's prefix up to it
--    (`place_path_consistent`). Checked on the restored paths themselves, so it
--    covers edits applied before this migration too.
-- 2. Enrichment of the kept entity (place-resolve setting its `wikidata_id`,
--    `country` and `wikidata_checked_at`): undo put back the kept entity's
--    metadata from before the merge, erasing it. `apply_entity_edit` now
--    records the kept entity's row as the merge left it (`into_after`), and
--    undo, holding a row lock on it, refuses if any field it would rewrite, or
--    the Wikidata lookup state, differs. An edit applied before this migration
--    has no `into_after`; the merge's own rule (each empty field filled from
--    the merged-away entity) gives what it left.

-- Whether every place `path` names above its last label exists with its own
-- path equal to `path` up to it. Null (unplaced) and one-label paths are.
create or replace function public.place_path_consistent(path extensions.ltree)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (
    select 1
    from generate_series(0, extensions.nlevel(path) - 2) as i(n)
    left join public.entities a on ('e' || a.seq) = extensions.subpath(path, i.n, 1)::text
    where a.id is null
       or coalesce(a.place_path, ('e' || a.seq)::extensions.ltree) operator(extensions.<>) extensions.subpath(path, 0, i.n + 1)
  )
$$;

-- The fields of an entity that a merge fills and its undo puts back, with
-- whether and how surely it was looked up on Wikidata (which only means
-- anything alongside the `wikidata_id` it found), for comparing a row with
-- what a merge left.
create or replace function public.entity_merge_fields(e public.entities)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'nace_code', e.nace_code, 'country', e.country, 'website', e.website,
    'description', e.description, 'wikidata_id', e.wikidata_id,
    'wikidata_checked_at', e.wikidata_checked_at, 'wikidata_p', e.wikidata_p)
$$;

-- Applies one staged edit and records its snapshot. keep and part_of change no
-- rows: they are a record that the pair was judged, so it isn't asked again.
-- A merge's snapshot also holds the kept entity as the merge left it.
create or replace function public.apply_entity_edit(edit_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  edit public.entity_edits;
  snap jsonb;
begin
  -- The placement lock comes first, before the edit row, in apply and undo
  -- alike, so concurrent edits can't wait on each other in opposite orders.
  perform pg_advisory_xact_lock(hashtext('public.entities.place_path'));
  select * into edit from public.entity_edits where id = edit_id for update;
  if not found then raise exception 'no edit %', edit_id; end if;
  if edit.status <> 'staged' then raise exception 'edit % is %, not staged', edit_id, edit.status; end if;
  snap := case edit.op
    when 'drop_mention' then public.drop_mention(edit)
    when 'merge' then public.merge_entity(edit)
    else '{}'::jsonb
  end;
  -- merge_entity holds a row lock on the kept entity until commit, so this is
  -- the row as the merge left it.
  if edit.op = 'merge' then
    snap := snap || jsonb_build_object('into_after',
      (select public.entity_merge_fields(e) from public.entities e where e.id = edit.into_id));
  end if;
  -- clock_timestamp, not now(): edits applied in one transaction stay in order.
  update public.entity_edits set status = 'applied', applied_at = clock_timestamp(), snapshot = snap where id = edit_id;
  return jsonb_build_object('edit', edit_id, 'op', edit.op, 'entity', edit.entity_name, 'into', edit.into_name);
end;
$$;

-- Puts an applied edit's rows back as they were, refusing when a later change
-- rests on them.
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
  left_by_merge jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('public.entities.place_path'));
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
    -- Held to commit, so nothing enriches the kept entity between this check
    -- and the restore.
    perform 1 from public.entities where id = t for update;
    if public.place_subtree(t) is distinct from coalesce(s -> 'places_after', public.place_subtree(t)) then
      raise exception 'edit %: places in or around % changed since; move them back first', edit_id, edit.into_name;
    end if;
    left_by_merge := coalesce(s -> 'into_after', jsonb_build_object(
      'nace_code', coalesce(s -> 'into' ->> 'nace_code', s -> 'entity' ->> 'nace_code'),
      'country', coalesce(s -> 'into' ->> 'country', s -> 'entity' ->> 'country'),
      'website', coalesce(s -> 'into' ->> 'website', s -> 'entity' ->> 'website'),
      'description', coalesce(s -> 'into' ->> 'description', s -> 'entity' ->> 'description'),
      'wikidata_id', coalesce(s -> 'into' ->> 'wikidata_id', s -> 'entity' ->> 'wikidata_id'),
      'wikidata_checked_at', s -> 'into' -> 'wikidata_checked_at',
      'wikidata_p', s -> 'into' -> 'wikidata_p'));
    -- Compared as typed values, so a timestamp's text form doesn't matter.
    if exists (
      select 1 from public.entities e, jsonb_populate_record(null::public.entities, left_by_merge) m
      where e.id = t
        and (e.nace_code, e.country, e.website, e.description, e.wikidata_id, e.wikidata_checked_at, e.wikidata_p)
          is distinct from (m.nace_code, m.country, m.website, m.description, m.wikidata_id, m.wikidata_checked_at, m.wikidata_p)
    ) then
      raise exception 'edit %: % was enriched since the merge; undo would erase it', edit_id, edit.into_name;
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
    -- Checked once everything is back (the merged-away place among them, which
    -- the paths inside it name); raising undoes the restore with the rest.
    if exists (
      select 1 from jsonb_array_elements(s -> 'moved' -> 'place_paths') o
      where not public.place_path_consistent((o ->> 'path')::extensions.ltree)
    ) or not public.place_path_consistent((s -> 'entity' ->> 'place_path')::extensions.ltree) then
      raise exception 'edit %: places % was in moved since; move them back first', edit_id, edit.entity_name;
    end if;
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

revoke execute on function public.place_path_consistent(extensions.ltree) from public, anon, authenticated;
revoke execute on function public.entity_merge_fields(public.entities) from public, anon, authenticated;
revoke execute on function public.apply_entity_edit(bigint) from public, anon, authenticated;
revoke execute on function public.undo_entity_edit(bigint) from public, anon, authenticated;
