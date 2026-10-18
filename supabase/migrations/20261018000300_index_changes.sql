-- Diffs of the entity index now carry what was removed or changed, not only
-- what was added, so a page keeps its copy current without reloading the
-- snapshot each time a mention is deleted, an entity renamed or duplicates
-- folded (20261016210000_entity_index.sql).
--
-- The triggers that bumped index_state.gen now write the keys they touched to
-- public.index_changes: a (link_seq, entity_seq) pair, an entity_seq or a
-- link_seq. index_diff(..., change_seq) reads the keys past a page's change
-- watermark (wm.c) and answers each with what is there now: a pair that
-- exists is in `pairs`, one that doesn't in `unpairs`; an entity that exists
-- is in `entities`, one that doesn't in `gone_entities`; a deleted link in
-- `gone_links`. Like a snapshot, the entities a diff carries are only ones some
-- link mentions; a touched entity nothing mentions is gone. Answering with the present state, not the history, makes a
-- diff safe to apply twice and in any order with the additions, so the page
-- can ask from below its watermark as it already does for additions.
--
-- `gen` still moves on every such change, for pages from before this change
-- (they reload on it, as they did) and for index-snapshot, which rebuilds when
-- it moves. A page that knows about the log goes by `reset_gen` instead: the
-- gen of the last bump the log can't carry (any update of gen made outside
-- these triggers, e.g. undo_entity_edit restoring rows under their old seqs).
-- A copy built at a gen below reset_gen reloads. So does one whose change
-- watermark is below what has been pruned from the log, or that is over
-- 2,000 changes behind (like the 2,000 new mentions rule).

alter table public.index_state
  add column reset_gen bigint not null default 1,
  add column changes_pruned_seq bigint not null default 0;

create table public.index_changes (
  seq bigint generated always as identity primary key,
  at timestamptz not null default now(),
  link_seq bigint,
  entity_seq bigint,
  check (link_seq is not null or entity_seq is not null)
);
alter table public.index_changes enable row level security;
create policy "index_changes is public" on public.index_changes for select to anon, authenticated using (true);

-- A gen bump from anywhere but the change triggers below is one a diff can't
-- carry. The triggers mark their own bump with a transaction-local setting,
-- cleared right after, so a later explicit bump in the same transaction still
-- counts.
create function public.index_state_reset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.gen is distinct from old.gen
     and coalesce(current_setting('seb.index_change', true), '') <> 'on' then
    new.reset_gen := new.gen;
  end if;
  return new;
end
$$;
revoke execute on function public.index_state_reset() from public, anon, authenticated;

create trigger index_state_reset
before update on public.index_state
for each row execute function public.index_state_reset();

create function public.index_change_bump()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('seb.index_change', 'on', true);
  update index_state set gen = gen + 1 where id;
  perform set_config('seb.index_change', '', true);
end
$$;
revoke execute on function public.index_change_bump() from public, anon, authenticated;

drop trigger link_entities_moved_bumps_index on public.link_entities;
drop trigger link_entities_deleted_bumps_index on public.link_entities;
drop trigger entities_changed_bumps_index on public.entities;
drop trigger entities_deleted_bumps_index on public.entities;
drop function public.bump_index_gen();

-- Deleted mentions. A mention deleted along with its link or entity (a
-- cascade) can't be named by seq any more; the link's or entity's own entry
-- covers it.
create function public.index_log_unpaired()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from gone) then return null; end if;
  insert into index_changes (link_seq, entity_seq)
  select l.seq, e.seq
  from gone g
  join links l on l.id = g.link_id
  join entities e on e.id = g.entity_id;
  perform index_change_bump();
  return null;
end
$$;
revoke execute on function public.index_log_unpaired() from public, anon, authenticated;

create trigger link_entities_deleted_logs_index
after delete on public.link_entities
referencing old table as gone
for each statement execute function public.index_log_unpaired();

-- Mentions moved to another link or entity (what a merge does): both the pair
-- it was and the pair it is. An upsert that only rewrites a mention's other
-- columns doesn't count.
create function public.index_log_moved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from old_rows o join new_rows n on n.seq = o.seq
    where o.link_id is distinct from n.link_id or o.entity_id is distinct from n.entity_id
  ) then
    return null;
  end if;
  insert into index_changes (link_seq, entity_seq)
  select l.seq, e.seq
  from old_rows o
  join new_rows n on n.seq = o.seq
  cross join lateral (values (o.link_id, o.entity_id), (n.link_id, n.entity_id)) as k(link_id, entity_id)
  join links l on l.id = k.link_id
  join entities e on e.id = k.entity_id
  where o.link_id is distinct from n.link_id or o.entity_id is distinct from n.entity_id;
  perform index_change_bump();
  return null;
end
$$;
revoke execute on function public.index_log_moved() from public, anon, authenticated;

create trigger link_entities_moved_logs_index
after update on public.link_entities
referencing old table as old_rows new table as new_rows
for each statement execute function public.index_log_moved();

-- Entities renamed or moved in the kind tree.
create function public.index_log_entity_changed()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into index_changes (entity_seq)
  select n.seq
  from old_rows o
  join new_rows n on n.id = o.id
  where o.name is distinct from n.name or o.kind is distinct from n.kind
    or o.kind_path is distinct from n.kind_path;
  if found then perform index_change_bump(); end if;
  return null;
end
$$;
revoke execute on function public.index_log_entity_changed() from public, anon, authenticated;

create trigger entities_changed_logs_index
after update on public.entities
referencing old table as old_rows new table as new_rows
for each statement execute function public.index_log_entity_changed();

create function public.index_log_entity_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into index_changes (entity_seq) select seq from gone;
  if found then perform index_change_bump(); end if;
  return null;
end
$$;
revoke execute on function public.index_log_entity_deleted() from public, anon, authenticated;

create trigger entities_deleted_logs_index
after delete on public.entities
referencing old table as gone
for each statement execute function public.index_log_entity_deleted();

-- Deleted links. Their mentions go by cascade, which bumps gen there; a link
-- nothing mentioned isn't in the index and needs no bump of its own.
create function public.index_log_link_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into index_changes (link_seq) select seq from gone;
  return null;
end
$$;
revoke execute on function public.index_log_link_deleted() from public, anon, authenticated;

create trigger links_deleted_logs_index
after delete on public.links
referencing old table as gone
for each statement execute function public.index_log_link_deleted();

-- The snapshot's watermark now includes `c`, the highest change it covers.
create or replace function public.index_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with kinds as (
    select public.index_kinds() as list
  ),
  ent as (
    select e.seq, e.name,
      (select (i.ord - 1)::integer
       from kinds, jsonb_array_elements(kinds.list) with ordinality as i(pair, ord)
       where i.pair->>0 = e.kind_path::text and i.pair->>1 = e.kind) as kind_index
    from entities e
    where exists (select 1 from link_entities le where le.entity_id = e.id)
  ),
  lnk as (
    select l.seq, (extract(epoch from l.created_at) / 60)::bigint as minute,
      array_agg(e.seq order by e.seq) as entity_seqs
    from links l
    join link_entities le on le.link_id = l.id
    join entities e on e.id = le.entity_id
    group by l.id
  )
  select jsonb_build_object(
    'v', 1,
    'gen', (select gen from index_state),
    'wm', jsonb_build_object(
      'l', (select coalesce(max(seq), 0) from links),
      'e', (select coalesce(max(seq), 0) from entities),
      'p', (select coalesce(max(seq), 0) from link_entities),
      'c', (select coalesce(max(seq), 0) from index_changes)
    ),
    'kinds', (select list from kinds),
    'entities', jsonb_build_object(
      'seq', (select coalesce(jsonb_agg(seq order by seq), '[]') from ent),
      'name', (select coalesce(jsonb_agg(name order by seq), '[]') from ent),
      'kind', (select coalesce(jsonb_agg(kind_index order by seq), '[]') from ent)
    ),
    'links', jsonb_build_object(
      'seq', (select coalesce(jsonb_agg(seq order by seq), '[]') from lnk),
      'minute', (select coalesce(jsonb_agg(minute order by seq), '[]') from lnk),
      'entities', (select coalesce(jsonb_agg(entity_seqs order by seq), '[]') from lnk)
    )
  )
$$;
revoke execute on function public.index_snapshot() from public, anon, authenticated;

-- Recording a snapshot also prunes the log. (Its arguments are now named in
-- full: as a SQL function, `snapshot_gen = gen` read index_state's own gen,
-- not the argument, so a snapshot published after a bump claimed the newer
-- gen.), keeping its newest 10,000
-- changes: a page further behind than 2,000 reloads anyway, and the margin
-- keeps a page asking from INDEX_DIFF_OVERLAP below its watermark clear of
-- the pruned range.
create or replace function public.index_snapshot_published(path text, gen bigint, link_seq bigint, entity_seq bigint, pair_seq bigint)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  floor_seq bigint;
begin
  update index_state set
    snapshot_path = index_snapshot_published.path,
    snapshot_gen = index_snapshot_published.gen,
    snapshot_link_seq = index_snapshot_published.link_seq,
    snapshot_entity_seq = index_snapshot_published.entity_seq,
    snapshot_pair_seq = index_snapshot_published.pair_seq,
    snapshot_at = now()
  where id;
  select max(c.seq) - 10000 into floor_seq from index_changes c;
  if floor_seq > 0 then
    delete from index_changes c where c.seq <= floor_seq;
    update index_state set changes_pruned_seq = greatest(changes_pruned_seq, floor_seq) where id;
  end if;
end
$$;
revoke execute on function public.index_snapshot_published(text, bigint, bigint, bigint, bigint) from public, anon, authenticated;

-- What changed after a watermark. Without `change_seq` it is the diff it was
-- (additions only, for pages from before this change). With it, it also
-- answers every key the log touched past it, as described at the top.
drop function public.index_diff(bigint, bigint, bigint);
create function public.index_diff(
  link_seq bigint default null, entity_seq bigint default null, pair_seq bigint default null,
  change_seq bigint default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  state index_state;
  pairs integer;
  changes integer;
  result jsonb;
begin
  select * into state from index_state;
  result := jsonb_build_object(
    'gen', state.gen,
    'reset_gen', state.reset_gen,
    'wm', jsonb_build_object(
      'l', (select coalesce(max(seq), 0) from links),
      'e', (select coalesce(max(seq), 0) from entities),
      'p', (select coalesce(max(seq), 0) from link_entities),
      'c', (select coalesce(max(seq), 0) from index_changes)
    ),
    'snapshot', case when state.snapshot_path is null then null else jsonb_build_object(
      'path', state.snapshot_path,
      'gen', state.snapshot_gen
    ) end,
    'kinds', public.index_kinds()
  );
  if link_seq is null or entity_seq is null or pair_seq is null then
    return result || jsonb_build_object('reload', true);
  end if;
  select count(*) into pairs from link_entities le where le.seq > pair_seq;
  if pairs > 2000 then
    return result || jsonb_build_object('reload', true);
  end if;
  if change_seq is not null then
    if change_seq < state.changes_pruned_seq then
      return result || jsonb_build_object('reload', true);
    end if;
    select count(*) into changes from index_changes c where c.seq > change_seq;
    if changes > 2000 then
      return result || jsonb_build_object('reload', true);
    end if;
  end if;

  return result || (
    with touched as (
      select distinct c.link_seq, c.entity_seq
      from index_changes c
      where change_seq is not null and c.seq > change_seq
    ),
    touched_pairs as (
      select t.link_seq, t.entity_seq, l.id as link_id, e.id as entity_id,
        exists (select 1 from link_entities le where le.link_id = l.id and le.entity_id = e.id) as present
      from touched t
      left join links l on l.seq = t.link_seq
      left join entities e on e.seq = t.entity_seq
      where t.link_seq is not null and t.entity_seq is not null
    ),
    -- (link id, entity id) of every mention the diff carries
    current_pairs as (
      select le.link_id, le.entity_id, le.seq as pair_order
      from link_entities le
      where le.seq > pair_seq
      union
      select tp.link_id, tp.entity_id, null
      from touched_pairs tp
      where tp.present
    )
    select jsonb_build_object(
      'reload', false,
      'pairs', (
        select coalesce(jsonb_agg(jsonb_build_array(l.seq, e.seq) order by cp.pair_order nulls last, l.seq, e.seq), '[]')
        from current_pairs cp
        join links l on l.id = cp.link_id
        join entities e on e.id = cp.entity_id
      ),
      'links', (
        select coalesce(jsonb_agg(jsonb_build_array(l.seq, (extract(epoch from l.created_at) / 60)::bigint)), '[]')
        from links l
        where l.id in (select cp.link_id from current_pairs cp)
      ),
      'entities', (
        select coalesce(jsonb_agg(jsonb_build_array(e.seq, e.name, e.kind_path::text, e.kind) order by e.seq), '[]')
        from entities e
        where e.id in (select cp.entity_id from current_pairs cp)
          or ((e.seq > entity_seq or e.seq in (select t.entity_seq from touched t where t.link_seq is null))
            and (change_seq is null or exists (select 1 from link_entities le where le.entity_id = e.id)))
      )
    ) || case when change_seq is null then '{}'::jsonb else jsonb_build_object(
      'unpairs', (
        select coalesce(jsonb_agg(jsonb_build_array(tp.link_seq, tp.entity_seq) order by tp.link_seq, tp.entity_seq), '[]')
        from touched_pairs tp
        where not tp.present
      ),
      'gone_entities', (
        select coalesce(jsonb_agg(t.entity_seq order by t.entity_seq), '[]')
        from touched t
        where t.link_seq is null and not exists (
          select 1 from entities e join link_entities le on le.entity_id = e.id where e.seq = t.entity_seq
        )
      ),
      'gone_links', (
        select coalesce(jsonb_agg(t.link_seq order by t.link_seq), '[]')
        from touched t
        where t.entity_seq is null and not exists (select 1 from links l where l.seq = t.link_seq)
      )
    ) end
  );
end
$$;
grant execute on function public.index_diff(bigint, bigint, bigint, bigint) to anon, authenticated;

-- One bump outside the triggers: every page reloads once, and the next
-- snapshot is built with a change watermark.
update public.index_state set gen = gen + 1 where id;
