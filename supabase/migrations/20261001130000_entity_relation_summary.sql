-- entity_relation_summary: one row per (subject, relation, object) over all the
-- links claiming it. Claims combine by noisy-OR, p = 1 - Π(1 - p_i), treating
-- each link as independent evidence: two links at 0.8 give 0.96, one shaky
-- claim stays low. `status` is what the newest claiming link reports, so a deal
-- later called off reads as called off. Readable like entity_relations itself.
create view public.entity_relation_summary
with (security_invoker = true)
as
select
  r.subject_id,
  r.relation,
  r.object_id,
  count(*)::integer as links,
  (1 - exp(sum(ln(1 - least(r.p, 0.999)::double precision))))::real as p,
  (array_agg(r.status order by l.created_at desc, l.id desc))[1] as status,
  min(l.created_at) as first_seen,
  max(l.created_at) as last_seen
from public.entity_relations r
join public.links l on l.id = r.link_id
group by r.subject_id, r.relation, r.object_id;

grant select on public.entity_relation_summary to anon, authenticated;
