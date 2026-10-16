-- index_state has one row, but the API's sessions load pg-safeupdate, which
-- rejects an UPDATE with no WHERE clause, even one run inside a function or a
-- trigger. So index-snapshot couldn't record its snapshot, and a delete of a
-- mention or an entity made through the API would have failed in the gen
-- trigger. Both now name the row.
create or replace function public.bump_index_gen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update index_state set gen = gen + 1 where id;
  return null;
end
$$;

create or replace function public.index_snapshot_published(path text, gen bigint, link_seq bigint, entity_seq bigint, pair_seq bigint)
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
  where id
$$;
