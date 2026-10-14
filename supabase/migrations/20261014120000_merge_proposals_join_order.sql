-- merge_proposals joined the kind witnesses of both sides on kind before
-- matching labels, so the planner built every same-kind entity pair (tens of
-- millions of rows) and ran out of temp disk. Each side now carries its kind
-- before the label self-join, which then matches on (value, kind) together.
create or replace function public.merge_proposals(max_results integer default 50, min_score real default 0.5)
returns table (
  entity_a uuid, name_a text, entity_b uuid, name_b text, kind text,
  score real, evidence jsonb, co_mentions integer
)
language sql stable security invoker as $$
  with labels as (
    select entity_id, value, link_id, p
    from public.identity_witnesses where sense = 'label'
  ),
  shared as (
    select value, count(distinct entity_id) as n
    from labels group by value having count(distinct entity_id) > 1
  ),
  best as (
    select l.entity_id, l.value, s.n,
           (array_agg(l.link_id order by l.p desc))[1] as link_id, max(l.p) as p
    from labels l join shared s using (value)
    group by l.entity_id, l.value, s.n
  ),
  kinds as (
    select entity_id, value as kind, max(p) as p
    from public.identity_witnesses
    where sense = 'kind' and entity_id in (select entity_id from best)
    group by entity_id, value
  ),
  sides as (
    select b.entity_id, b.value, b.n, b.link_id, b.p * k.p as p, k.kind
    from best b join kinds k using (entity_id)
  ),
  paths as (
    select a.entity_id as a, b.entity_id as b, a.kind, a.value,
           a.link_id as link_a, b.link_id as link_b,
           a.p * b.p / (a.n - 1) as p
    from sides a
    join sides b on b.value = a.value and b.kind = a.kind and a.entity_id < b.entity_id
  ),
  scored as (
    select a, b, kind,
           1 - exp(sum(ln(1 - least(p, 0.999999)))) as score,
           jsonb_agg(jsonb_build_object(
             'label', value, 'link_a', link_a, 'link_b', link_b, 'p', round(p::numeric, 3)
           ) order by p desc) as evidence
    from paths group by a, b, kind
  )
  select s.a, ea.name, s.b, eb.name, s.kind, s.score::real, s.evidence,
         (select count(distinct x.link_id)::integer
            from public.link_entities x
            join public.link_entities y on y.link_id = x.link_id
           where x.entity_id = s.a and y.entity_id = s.b)
  from scored s
  join public.entities ea on ea.id = s.a
  join public.entities eb on eb.id = s.b
  where s.score >= min_score
    and not (ea.wikidata_id is not null and eb.wikidata_id is not null
             and ea.wikidata_id <> eb.wikidata_id)
  order by s.score desc, s.a, s.b
  limit max_results
$$;

revoke execute on function public.merge_proposals(integer, real) from public, anon, authenticated;
