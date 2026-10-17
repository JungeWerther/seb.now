-- `%` is what lets entities_name_trgm_idx and link_entities_surface_trgm_idx
-- find the matches. It reads pg_trgm.similarity_threshold, pinned to the
-- cut-off below so a caller's own setting can't drop candidates; a function
-- may only SET it once pg_trgm is loaded, which show_limit() does.
select extensions.show_limit();

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
