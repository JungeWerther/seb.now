-- Guards as expressions: `must(ok, message)` raises unless `ok` is true,
-- `refuse(bad, message)` raises when `bad` is true (null passes, as in
-- `if bad then raise`). The entity-edit functions check their preconditions
-- with these instead of `if … then raise … end if`, and undo dispatches on the
-- edit's op the way apply does, to `restore_mention` / `unmerge_entity`.
-- Behaviour is unchanged.

create or replace function public.must(ok boolean, message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if ok is not true then raise exception '%', message; end if;
end;
$$;

create or replace function public.refuse(bad boolean, message text)
returns void
language sql
set search_path = ''
as $$
  select public.must(bad is not true, message)
$$;

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
  perform public.must(jsonb_array_length(snap -> 'link_entities') > 0,
    format('edit %s: %s has no mention on link %s', edit.id, edit.entity_name, edit.link_id));
  return snap;
end;
$$;

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
  perform public.must(exists (select 1 from public.entities where id = f),
    format('edit %s: entity %s is gone', edit.id, edit.entity_name));
  perform public.must(exists (select 1 from public.entities where id = t),
    format('edit %s: entity %s is gone', edit.id, edit.into_name));
  -- Merges run after any placement in flight (the same lock set_place_parent
  -- takes), and merges touching the same entities one after another, so each
  -- snapshot is taken after the previous change committed.
  perform pg_advisory_xact_lock(hashtext('public.entities.place_path'));
  perform pg_advisory_xact_lock(hashtext(least(f, t)::text));
  perform pg_advisory_xact_lock(hashtext(greatest(f, t)::text));
  -- Row locks on both: a concurrent insert referencing either (a new mention,
  -- relation or location) takes a key-share lock on it, so it waits for this
  -- merge and then fails on the deleted source instead of being cascaded away.
  perform 1 from public.entities where id in (f, t) order by id for update;
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
  perform public.refuse(public.place_self(t) operator(extensions.<@) public.place_self(f),
    format('edit %s: %s lies inside %s; place it elsewhere first', edit.id, tname, edit.entity_name));
  perform public.refuse(
    exists (select 1 from public.entities c where c.id <> f and c.place_path operator(extensions.<@) public.place_self(f))
      and not exists (select 1 from public.entities e where e.id = t and e.kind_path operator(extensions.<@) 'entity.place'::extensions.ltree),
    format('edit %s: places lie inside %s, but %s is not a place', edit.id, edit.entity_name, tname));
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'path', c.place_path::text, 'by', c.place_labeled_by)), '[]')
  into placed
  from public.entities c
  where c.id <> f and (c.id = t
    or c.place_path operator(extensions.<@) public.place_self(f)
    or c.place_path operator(extensions.<@) public.place_self(t));
  -- (not when the target is one of the places the merged-away one is in)
  perform public.set_place_parent(t, public.place_parent(f), (snap -> 'entity' ->> 'place_labeled_by'))
  where (select place_path is null from public.entities where id = t) and public.place_parent(f) is not null
    and not (public.place_self(f) operator(extensions.<@) public.place_self(t));
  update public.entities c
  set place_path = public.place_self(t) operator(extensions.||)
    extensions.subpath(c.place_path, extensions.nlevel(public.place_self(f)))
  where c.id <> f and c.place_path operator(extensions.<@) public.place_self(f);
  moved := moved || jsonb_build_object('place_paths', placed);

  delete from public.entities where id = f;
  -- The target's place and everything inside it as left by this merge (the
  -- merged-away entity gone): undo refuses if a later placement changed them.
  snap := snap || jsonb_build_object('places_after', public.place_subtree(t));
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
      -- The places the merged-away entity was in: undo puts it back under them.
      union select a.id::text from public.entities a
        where extensions.index((snap -> 'entity' ->> 'place_path')::extensions.ltree, ('e' || a.seq)::extensions.ltree) >= 0
          and a.id <> f
      union select e ->> 'entity_id' from jsonb_array_elements(snap -> 'edits') e
      union select e ->> 'into_id' from jsonb_array_elements(snap -> 'edits') e where e ->> 'into_id' is not null) u));
end;
$$;

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
  perform public.must(exists (
      select 1 from public.entities e
      where e.id = parent and e.kind_path operator(extensions.<@) 'entity.place'::extensions.ltree),
    format('parent %s of %s is not a place', parent, entity));
  old_self := public.place_self(entity);
  perform public.must(old_self is not null, format('no entity %s', entity));
  perform public.refuse(public.place_self(parent) operator(extensions.<@) old_self,
    format('placing %s in %s would make a cycle', entity, parent));
  new_self := public.place_self(parent) operator(extensions.||) public.place_label(entity);
  update public.entities set place_path = new_self, place_labeled_by = labeled_by where id = entity;
  update public.entities c
  set place_path = new_self operator(extensions.||) extensions.subpath(c.place_path, extensions.nlevel(old_self))
  where c.id <> entity and c.place_path operator(extensions.<@) old_self;
  return new_self;
end;
$$;

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
  perform public.must(found, format('no edit %s', edit_id));
  perform public.must(edit.status = 'staged', format('edit %s is %s, not staged', edit_id, edit.status));
  snap := case edit.op
    when 'drop_mention' then public.drop_mention(edit)
    when 'merge' then public.merge_entity(edit)
    else '{}'::jsonb
  end;
  -- merge_entity holds a row lock on the kept entity until commit, so this is
  -- the row as the merge left it.
  snap := snap || case edit.op
    when 'merge' then jsonb_build_object('into_after',
      (select public.entity_merge_fields(e) from public.entities e where e.id = edit.into_id))
    else '{}'::jsonb
  end;
  -- clock_timestamp, not now(): edits applied in one transaction stay in order.
  update public.entity_edits set status = 'applied', applied_at = clock_timestamp(), snapshot = snap where id = edit_id;
  return jsonb_build_object('edit', edit_id, 'op', edit.op, 'entity', edit.entity_name, 'into', edit.into_name);
end;
$$;

-- Puts a dropped mention back: witnesses first, so the mention's insert
-- trigger finds its label already back.
create or replace function public.restore_mention(edit public.entity_edits)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.identity_witnesses overriding system value
  select * from jsonb_populate_recordset(null::public.identity_witnesses, edit.snapshot -> 'identity_witnesses')
  on conflict do nothing;
  insert into public.link_entities overriding system value
  select * from jsonb_populate_recordset(null::public.link_entities, edit.snapshot -> 'link_entities');
end;
$$;

-- Puts a merge's rows back, refusing when the kept entity or the places it
-- would restore changed since.
create or replace function public.unmerge_entity(edit public.entity_edits)
returns void
language plpgsql
set search_path = ''
as $$
declare
  s jsonb := edit.snapshot;
  f uuid := edit.entity_id;
  t uuid := edit.into_id;
  left_by_merge jsonb;
begin
  -- Held to commit, so nothing enriches the kept entity between this check
  -- and the restore.
  perform 1 from public.entities where id = t for update;
  perform public.must(public.place_subtree(t) is not distinct from coalesce(s -> 'places_after', public.place_subtree(t)),
    format('edit %s: places in or around %s changed since; move them back first', edit.id, edit.into_name));
  left_by_merge := coalesce(s -> 'into_after', jsonb_build_object(
    'nace_code', coalesce(s -> 'into' ->> 'nace_code', s -> 'entity' ->> 'nace_code'),
    'country', coalesce(s -> 'into' ->> 'country', s -> 'entity' ->> 'country'),
    'website', coalesce(s -> 'into' ->> 'website', s -> 'entity' ->> 'website'),
    'description', coalesce(s -> 'into' ->> 'description', s -> 'entity' ->> 'description'),
    'wikidata_id', coalesce(s -> 'into' ->> 'wikidata_id', s -> 'entity' ->> 'wikidata_id'),
    'wikidata_checked_at', s -> 'into' -> 'wikidata_checked_at',
    'wikidata_p', s -> 'into' -> 'wikidata_p'));
  -- Compared as typed values, so a timestamp's text form doesn't matter.
  perform public.refuse(exists (
      select 1 from public.entities e, jsonb_populate_record(null::public.entities, left_by_merge) m
      where e.id = t
        and (e.nace_code, e.country, e.website, e.description, e.wikidata_id, e.wikidata_checked_at, e.wikidata_p)
          is distinct from (m.nace_code, m.country, m.website, m.description, m.wikidata_id, m.wikidata_checked_at, m.wikidata_p)),
    format('edit %s: %s was enriched since the merge; undo would erase it', edit.id, edit.into_name));
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
  perform public.refuse(
    exists (
      select 1 from jsonb_array_elements(s -> 'moved' -> 'place_paths') o
      where not public.place_path_consistent((o ->> 'path')::extensions.ltree)
    ) or not public.place_path_consistent((s -> 'entity' ->> 'place_path')::extensions.ltree),
    format('edit %s: places %s was in moved since; move them back first', edit.id, edit.entity_name));
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
begin
  perform pg_advisory_xact_lock(hashtext('public.entities.place_path'));
  select * into edit from public.entity_edits where id = edit_id for update;
  perform public.must(found, format('no edit %s', edit_id));
  perform public.must(edit.status = 'applied', format('edit %s is %s, not applied', edit_id, edit.status));
  -- Undo in reverse order: a later applied edit about the same entities (or,
  -- for a drop, the same mention) may rest on this one's rows.
  perform public.refuse(exists (
      select 1 from public.entity_edits later
      where later.status = 'applied' and (later.applied_at, later.id) > (edit.applied_at, edit.id)
        and (later.entity_id::text in (select jsonb_array_elements_text(edit.snapshot -> 'touched'))
          or later.into_id::text in (select jsonb_array_elements_text(edit.snapshot -> 'touched'))
          or coalesce(later.snapshot -> 'touched', '[]') ?| array(select jsonb_array_elements_text(edit.snapshot -> 'touched')))),
    format('edit %s: undo the later applied edits about %s first', edit_id, edit.entity_name));

  perform case edit.op
    when 'drop_mention' then public.restore_mention(edit)
    when 'merge' then public.unmerge_entity(edit)
  end;

  -- Restored rows keep their old seq, below what readers' index copies already
  -- hold, so a new index generation makes them reload.
  update public.index_state set gen = gen + 1 where id and edit.op in ('drop_mention', 'merge');
  update public.entity_edits set status = 'undone' where id = edit_id;
  return jsonb_build_object('edit', edit_id, 'op', edit.op, 'undone', true);
end;
$$;

revoke execute on function public.must(boolean, text) from public, anon, authenticated;
revoke execute on function public.refuse(boolean, text) from public, anon, authenticated;
revoke execute on function public.drop_mention(public.entity_edits) from public, anon, authenticated;
revoke execute on function public.merge_entity(public.entity_edits) from public, anon, authenticated;
revoke execute on function public.set_place_parent(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_entity_edit(bigint) from public, anon, authenticated;
revoke execute on function public.restore_mention(public.entity_edits) from public, anon, authenticated;
revoke execute on function public.unmerge_entity(public.entity_edits) from public, anon, authenticated;
revoke execute on function public.undo_entity_edit(bigint) from public, anon, authenticated;
