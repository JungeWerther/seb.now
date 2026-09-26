-- ranked_feed: the default feed order, one page at a time.
--
--   rank = taste * (1 + ups) / (2 + ups + downs) * 0.5 ^ (age_hours / 24)
--
-- taste is the caller's p-weighted mean Beta score over the link's topics,
-- from user_topic_preferences (a never-voted topic falls back to its parent,
-- then to a neutral 0.5; untagged links are 0.5). ups/downs are everyone's
-- votes on the link. Age is measured at `as_of`, which the client fixes when
-- it starts the feed so ranks don't shift between pages; links created after
-- it are left out.
--
-- security invoker: auth.uid() is the caller, and RLS applies as for them.
create function public.ranked_feed(as_of timestamptz, page_offset integer, page_size integer)
returns table (link_id uuid, rank double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with mine as (
    select topic_id, alpha / (alpha + beta) as score
    from public.user_topic_preferences
    where voter_id = auth.uid()
  ),
  link_taste as (
    select
      lt.link_id,
      sum(lt.p * coalesce(own.score, parent.score, 0.5)) / sum(lt.p) as taste
    from public.link_topics lt
    left join mine own on own.topic_id operator(extensions.=) lt.topic_id
    left join mine parent
      on extensions.nlevel(lt.topic_id) > 1
     and parent.topic_id operator(extensions.=) extensions.subpath(lt.topic_id, 0, extensions.nlevel(lt.topic_id) - 1)
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
      * power(0.5, extract(epoch from as_of - l.created_at) / 3600 / 24) as rank
  from public.links l
  left join link_taste t on t.link_id = l.id
  left join link_votes v on v.link_id = l.id
  where l.created_at <= as_of
  order by rank desc, l.id desc
  offset page_offset
  limit page_size
$$;

grant execute on function public.ranked_feed(timestamptz, integer, integer) to anon, authenticated;
