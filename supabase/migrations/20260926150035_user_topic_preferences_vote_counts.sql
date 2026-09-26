-- Adds per-topic upvote/downvote counts (distinct links) so a client can show
-- how many of a user's votes on a topic were negative, not just the weighted
-- likes/dislikes sums.
create or replace view public.user_topic_preferences
with (security_invoker = true) as
select
  v.voter_id,
  extensions.subpath(lt.topic_id, 0, depth.n) as topic_id,
  coalesce(sum(lt.p) filter (where v.value = 1), 0) as likes,
  coalesce(sum(lt.p) filter (where v.value = -1), 0) as dislikes,
  1 + coalesce(sum(lt.p) filter (where v.value = 1), 0) as alpha,
  1 + coalesce(sum(lt.p) filter (where v.value = -1), 0) as beta,
  count(distinct v.link_id) as votes,
  count(distinct v.link_id) filter (where v.value = 1) as upvotes,
  count(distinct v.link_id) filter (where v.value = -1) as downvotes
from public.votes v
join public.link_topics lt on lt.link_id = v.link_id
cross join lateral generate_series(1, extensions.nlevel(lt.topic_id)) as depth(n)
group by v.voter_id, extensions.subpath(lt.topic_id, 0, depth.n);
