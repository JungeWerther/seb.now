-- ranked_feed: cap the age in the freshness factor. youtube-ingest dates a
-- video by its upload date, and 0.5 ^ (age_days) for a years-old upload is
-- below the smallest double, which Postgres raises as an error rather than
-- rounding to 0 - so the whole feed failed to rank. 0.5 ^ 1000 is already
-- ~1e-301, so capping there changes no ordering.
create or replace function public.ranked_feed(as_of timestamptz, page_offset integer, page_size integer)
returns table (link_id uuid, rank double precision)
language sql
stable
security invoker
set search_path to ''
as $$
  with overrides as (
    select topic_id, score
    from public.topic_overrides
    where user_id = auth.uid()
  ),
  mine as (
    select topic_id, score from overrides
    union all
    select p.topic_id, p.alpha / (p.alpha + p.beta)
    from public.user_topic_preferences p
    where p.voter_id = auth.uid()
      and not exists (select 1 from overrides o where o.topic_id operator(extensions.=) p.topic_id)
  ),
  labels as (
    select shared.link_id, shared.topic_id, shared.p
    from public.link_topics shared
    where not exists (
      select 1 from public.link_topic_suggestions s
      where s.link_id = shared.link_id
        and s.topic_id operator(extensions.=) shared.topic_id
        and s.suggested_by = auth.uid()
    )
    union all
    select s.link_id, s.topic_id, s.p
    from public.link_topic_suggestions s
    where s.suggested_by = auth.uid()
  ),
  link_taste as (
    select
      lt.link_id,
      sum(lt.p * coalesce(
        (select m.score from mine m
         where m.topic_id operator(extensions.@>) lt.topic_id
         order by extensions.nlevel(m.topic_id) desc
         limit 1),
        0.5
      )) / sum(lt.p) as taste
    from labels lt
    group by lt.link_id
  ),
  link_votes as (
    select
      link_id,
      count(*) filter (where value = 1) as ups,
      count(*) filter (where value = -1) as downs
    from public.votes
    group by link_id
  )
  select
    l.id,
    coalesce(t.taste, 0.5)
      * (1 + coalesce(v.ups, 0))::double precision / (2 + coalesce(v.ups, 0) + coalesce(v.downs, 0))
      * power(0.5::double precision, least(extract(epoch from as_of - l.created_at) / 3600 / 24, 1000)::double precision) as rank
  from public.links l
  left join link_taste t on t.link_id = l.id
  left join link_votes v on v.link_id = l.id
  where l.created_at <= as_of
  order by rank desc, l.id desc
  offset page_offset
  limit page_size
$$;
