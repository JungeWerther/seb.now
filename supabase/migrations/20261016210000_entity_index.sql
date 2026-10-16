-- The entity index the page keeps for itself: every entity's name and kind and
-- which links mention it, so the search box can match names and run filter
-- queries ("event paris") without asking the database each time.
--
-- The page gets it in two parts:
--   * a snapshot, built by the index-snapshot Edge Function into the public
--     `index` Storage bucket under a new name each time (so the CDN may cache
--     it forever), which the page keeps in IndexedDB;
--   * diffs, `index_diff(...)`: what was added since the snapshot's watermark.
--
-- Rows are counted by `seq`, an identity column on links, entities and
-- link_entities; a watermark is the highest seq of each the page has seen.
-- Diffs only carry additions. Anything else (a mention or an entity deleted, an
-- entity renamed or moved in the kind tree, a mention moved to another entity,
-- which is what folding duplicates does) bumps `index_state.gen` instead, and a
-- page whose snapshot has an older gen drops it and loads the current one,
-- asking the database directly until a snapshot of the current gen exists.

alter table public.links add column seq bigint generated always as identity;
alter table public.entities add column seq bigint generated always as identity;
alter table public.link_entities add column seq bigint generated always as identity;
create unique index links_seq_idx on public.links (seq);
create unique index entities_seq_idx on public.entities (seq);
create unique index link_entities_seq_idx on public.link_entities (seq);

-- One row. `gen` counts changes that diffs can't carry; the snapshot_* columns
-- describe the latest snapshot: its object name in the bucket, the gen it was
-- built at, and its watermark.
create table public.index_state (
  id boolean primary key default true check (id),
  gen bigint not null default 1,
  snapshot_path text check (snapshot_path ~ '^snapshots/[0-9a-z-]+\.json\.gz$'),
  snapshot_gen bigint,
  snapshot_link_seq bigint,
  snapshot_entity_seq bigint,
  snapshot_pair_seq bigint,
  snapshot_at timestamptz
);
insert into public.index_state default values;
alter table public.index_state enable row level security;
create policy "index_state is public" on public.index_state for select to anon, authenticated using (true);

create function public.bump_index_gen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update index_state set gen = gen + 1;
  return null;
end
$$;
revoke execute on function public.bump_index_gen() from public, anon, authenticated;

-- An upsert that conflicts rewrites a mention's other columns but not its
-- link or entity, so it doesn't count.
create trigger link_entities_moved_bumps_index
after update on public.link_entities
for each row
when (old.link_id is distinct from new.link_id or old.entity_id is distinct from new.entity_id)
execute function public.bump_index_gen();

create trigger link_entities_deleted_bumps_index
after delete on public.link_entities
for each statement
execute function public.bump_index_gen();

create trigger entities_changed_bumps_index
after update on public.entities
for each row
when (old.name is distinct from new.name or old.kind is distinct from new.kind
  or old.kind_path is distinct from new.kind_path)
execute function public.bump_index_gen();

create trigger entities_deleted_bumps_index
after delete on public.entities
for each statement
execute function public.bump_index_gen();

-- The kinds an entity can have, as (kind_path, kind) pairs; entities refer to
-- one by its position in this list (`kinds` in the snapshot). Sorted, so the
-- list only changes when a new pair appears.
create function public.index_kinds()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_array(kp, k) order by kp, k), '[]'::jsonb)
  from (select distinct kind_path::text as kp, kind as k from entities) x
$$;

-- The whole index, as compact arrays (see index-snapshot for the format).
-- Only entities some link mentions are in it. Built in one statement, so its
-- gen and watermark describe exactly what it holds. Service role only: it reads
-- everything.
create function public.index_snapshot()
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
      'p', (select coalesce(max(seq), 0) from link_entities)
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

-- Records a snapshot the function has uploaded. Service role only.
create function public.index_snapshot_published(path text, gen bigint, link_seq bigint, entity_seq bigint, pair_seq bigint)
returns void
language sql
security invoker
set search_path = public
as $$
  update index_state set
    snapshot_path = path,
    snapshot_gen = gen,
    snapshot_link_seq = link_seq,
    snapshot_entity_seq = entity_seq,
    snapshot_pair_seq = pair_seq,
    snapshot_at = now()
$$;
revoke execute on function public.index_snapshot_published(text, bigint, bigint, bigint, bigint) from public, anon, authenticated;

-- What was added after a watermark: mentions with a higher seq, the links they
-- belong to, and the entities that are new or that those mentions name. Rows
-- of a transaction still open when the page asked can commit later with a
-- lower seq than what it has seen, so the page asks from a little below its
-- watermark and drops what it already has. With no watermark (or a diff over
-- INDEX_DIFF_MAX_PAIRS mentions, 2,000) it carries no rows, only `gen`, the
-- current watermark and the latest snapshot, to load instead.
create function public.index_diff(link_seq bigint default null, entity_seq bigint default null, pair_seq bigint default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  state index_state;
  pairs integer;
  result jsonb;
begin
  select * into state from index_state;
  result := jsonb_build_object(
    'gen', state.gen,
    'wm', jsonb_build_object(
      'l', (select coalesce(max(seq), 0) from links),
      'e', (select coalesce(max(seq), 0) from entities),
      'p', (select coalesce(max(seq), 0) from link_entities)
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
  return result || jsonb_build_object(
    'reload', false,
    'pairs', (
      select coalesce(jsonb_agg(jsonb_build_array(l.seq, e.seq) order by le.seq), '[]')
      from link_entities le
      join links l on l.id = le.link_id
      join entities e on e.id = le.entity_id
      where le.seq > pair_seq
    ),
    'links', (
      select coalesce(jsonb_agg(jsonb_build_array(l.seq, (extract(epoch from l.created_at) / 60)::bigint)), '[]')
      from links l
      where l.id in (select le.link_id from link_entities le where le.seq > pair_seq)
    ),
    'entities', (
      select coalesce(jsonb_agg(jsonb_build_array(e.seq, e.name, e.kind_path::text, e.kind) order by e.seq), '[]')
      from entities e
      where e.seq > entity_seq
        or e.id in (select le.entity_id from link_entities le where le.seq > pair_seq)
    )
  );
end
$$;
grant execute on function public.index_diff(bigint, bigint, bigint) to anon, authenticated;

-- The public bucket the snapshots go in. Only JSON, gzipped; the function
-- uploads them with service_role, nobody else writes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('index', 'index', true, 20971520, array['application/gzip'])
on conflict (id) do nothing;

-- Every 10 minutes; the function does nothing when the index hasn't changed
-- since the last snapshot. Sends the anon key like the other jobs (verify_jwt
-- on; the function writes with its own service role).
select cron.schedule(
  'index-snapshot',
  '9-59/10 * * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/index-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
