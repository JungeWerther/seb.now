-- Inputs for phase_ngrams_eval.py, read-only. Run each statement (e.g. through
-- the Supabase MCP's execute_sql), and save the single JSON value it returns as
-- the named file in one directory.

-- entities.json: every non-source entity, [seq, name].
select json_agg(json_build_array(seq, name) order by seq) from entities where kind <> 'source';

-- baseline.json: the matching pairs, each with both baselines' rankings and
-- their server-side time:
--   [source, query, target seq, own seq (merges), entity_candidates(query, 9) as [seq, similarity],
--    the names-only pg_trgm branch (top 9 at its 0.3 threshold), ms entity_candidates, ms names-only]
-- Positives: a mention surface that differs from its entity's name; a label
-- witness that differs from the name and isn't such a surface; a merge in
-- entity_edits (its merged-away name to the kept entity, the merged-away
-- entity itself excluded from the ranking).
with s as (
  select 'surface' src, min(m.surface) q, e.seq tgt, null::bigint self
  from link_entities m join entities e on e.id = m.entity_id
  where e.kind <> 'source' and m.surface is not null and lower(m.surface) <> lower(e.name)
  group by lower(m.surface), e.seq),
w as (
  select 'witness' src, min(w.value) q, e.seq tgt, null::bigint self
  from identity_witnesses w join entities e on e.id = w.entity_id
  where w.sense = 'label' and e.kind <> 'source' and lower(w.value) <> lower(e.name)
    and not exists (select 1 from s where lower(s.q) = lower(w.value) and s.tgt = e.seq)
  group by lower(w.value), e.seq),
g as (
  select 'merge' src, a.name q, b.seq tgt, a.seq self
  from entity_edits x join entities a on a.id = x.entity_id join entities b on b.id = x.into_id
  where x.op = 'merge' and a.kind <> 'source' and b.kind <> 'source'),
p as (select * from s union all select * from w union all select * from g),
r as (
  select p.*, clock_timestamp() t0,
    (select json_agg(json_build_array(e.seq, round(c.similarity::numeric, 3)) order by c.ord)
       from entity_candidates(p.q, 9) with ordinality c(id, name, kind, description, example_title, similarity, ord)
       join entities e on e.id = c.id) ec,
    clock_timestamp() t1,
    (select json_agg(json_build_array(z.seq, round(z.sim::numeric, 3)) order by z.sim desc, z.seq)
       from (select e.seq, extensions.similarity(lower(e.name), lower(p.q)) sim from entities e
             where lower(e.name) operator(extensions.%) lower(p.q) and e.kind <> 'source'
             order by 2 desc, e.created_at limit 9) z) nm,
    clock_timestamp() t2
  from p)
select json_agg(json_build_array(src, q, tgt, self, ec, nm,
  round(extract(epoch from t1 - t0)::numeric * 1000, 3),
  round(extract(epoch from t2 - t1)::numeric * 1000, 3)))
from r;
