-- entity_candidates: #111's trigram-indexed matching, plus the merged-away
-- names entity_sense added. 20261017180000_entity_sense.sql redefined the
-- function after 20261017170000_entity_candidates_trgm_index.sql and so put
-- back the full scan; this keeps both: names and mention surfaces through
-- their trigram indexes, and label witnesses not tied to a post (a merge's,
-- or one given by hand) through a partial trigram index of their own.
select extensions.show_limit();

create index if not exists identity_witnesses_alias_trgm_idx
  on public.identity_witnesses using gin (value extensions.gin_trgm_ops)
  where sense = 'label' and (link_id is null or labeled_by = 'merge');

create or replace function public.entity_candidates(phrase text, max_results integer default 8)
returns table(id uuid, name text, kind text, description text, example_title text, similarity real)
language sql stable
set search_path = public, extensions
set pg_trgm.similarity_threshold = 0.3
as $$
  with hits as (
    select e.id, similarity(lower(e.name), lower(phrase)) as similarity
    from entities e
    where lower(e.name) % lower(phrase) and e.kind <> 'source'
    union all
    select m.entity_id, similarity(lower(m.surface), lower(phrase))
    from link_entities m join entities e on e.id = m.entity_id
    where lower(m.surface) % lower(phrase) and e.kind <> 'source'
    union all
    select w.entity_id, similarity(w.value, lower(phrase))
    from identity_witnesses w join entities e on e.id = w.entity_id
    where w.sense = 'label' and (w.link_id is null or w.labeled_by = 'merge')
      and w.value % lower(phrase) and e.kind <> 'source'
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
