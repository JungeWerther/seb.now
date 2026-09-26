-- user_topic_preferences: each voter's per-topic Beta(alpha, beta) parameters,
-- derived from their votes rather than stored, so removing a vote removes its
-- effect. An upvote on a link adds that link's topic probabilities p to
-- `likes`; a downvote adds them to `dislikes`. alpha/beta add the uniform
-- Beta(1, 1) prior. Every vote also counts toward each ancestor of the
-- labelled topic ('ai.agents' feeds 'ai'), so a parent carries evidence a
-- never-voted-on sibling can fall back to.
--
-- security_invoker so RLS on votes/link_topics applies to the caller rather
-- than to the view's owner.
create view public.user_topic_preferences
with (security_invoker = true) as
select
  v.voter_id,
  extensions.subpath(lt.topic_id, 0, depth.n) as topic_id,
  coalesce(sum(lt.p) filter (where v.value = 1), 0) as likes,
  coalesce(sum(lt.p) filter (where v.value = -1), 0) as dislikes,
  1 + coalesce(sum(lt.p) filter (where v.value = 1), 0) as alpha,
  1 + coalesce(sum(lt.p) filter (where v.value = -1), 0) as beta,
  count(distinct v.link_id) as votes
from public.votes v
join public.link_topics lt on lt.link_id = v.link_id
cross join lateral generate_series(1, extensions.nlevel(lt.topic_id)) as depth(n)
group by v.voter_id, extensions.subpath(lt.topic_id, 0, depth.n);

grant select on public.user_topic_preferences to anon, authenticated;
