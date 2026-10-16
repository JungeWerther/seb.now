-- Contributed topics: any signed-in user (anonymous included) can propose a
-- new topic under an existing one, back it with example links, and endorse
-- others' proposals. Proposals never touch public.topics directly, because a
-- topic's description is what a classifier reads; one becomes a topic only
-- when accept_topic_proposal is run by hand (service_role / SQL editor).

alter table public.topics
  add column proposed_by uuid references public.profiles (id) on delete set null;

create table public.topic_proposals (
  id uuid primary key default gen_random_uuid(),
  topic_id extensions.ltree not null
    check (topic_id::text ~ '^[a-z0-9_]{2,32}(\.[a-z0-9_]{2,32}){1,2}$'),
  parent_id extensions.ltree not null
    generated always as (extensions.subpath(topic_id, 0, extensions.nlevel(topic_id) - 1)) stored
    references public.topics (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text not null check (char_length(btrim(description)) between 10 and 300),
  rationale text check (char_length(rationale) <= 500),
  proposed_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create unique index topic_proposals_one_open_per_topic
  on public.topic_proposals (topic_id) where status = 'open';
create index topic_proposals_proposed_by_idx on public.topic_proposals (proposed_by);

create function public.check_topic_proposal() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.topics t where t.id operator(extensions.=) new.topic_id) then
    raise exception 'topic % already exists', new.topic_id;
  end if;
  if (select count(*) from public.topic_proposals p
      where p.proposed_by = new.proposed_by and p.status = 'open') >= 5 then
    raise exception 'at most 5 open topic proposals per user';
  end if;
  return new;
end;
$$;

create trigger topic_proposals_check
  before insert on public.topic_proposals
  for each row execute function public.check_topic_proposal();

alter table public.topic_proposals enable row level security;

create policy "topic proposals are publicly readable" on public.topic_proposals
  for select to anon, authenticated using (true);
create policy "Users propose topics as themselves" on public.topic_proposals
  for insert to authenticated
  with check ((select auth.uid()) = proposed_by and status = 'open');
create policy "Users withdraw their own open proposals" on public.topic_proposals
  for delete to authenticated
  using ((select auth.uid()) = proposed_by and status = 'open');

revoke all on public.topic_proposals from anon, authenticated;
grant select on public.topic_proposals to anon, authenticated;
grant insert (topic_id, name, description, rationale), delete on public.topic_proposals to authenticated;

-- Links the proposer says belong in the new topic; on acceptance they become
-- its first link_topics labels.
create table public.topic_proposal_examples (
  proposal_id uuid not null references public.topic_proposals (id) on delete cascade,
  link_id uuid not null references public.links (id) on delete cascade,
  p real not null default 1 check (p > 0 and p <= 1),
  primary key (proposal_id, link_id)
);

create index topic_proposal_examples_link_id_idx on public.topic_proposal_examples (link_id);

alter table public.topic_proposal_examples enable row level security;

create policy "topic proposal examples are publicly readable" on public.topic_proposal_examples
  for select to anon, authenticated using (true);
create policy "Proposers add examples to their open proposals" on public.topic_proposal_examples
  for insert to authenticated
  with check (exists (
    select 1 from public.topic_proposals p
    where p.id = proposal_id and p.proposed_by = (select auth.uid()) and p.status = 'open'
  ));

revoke all on public.topic_proposal_examples from anon, authenticated;
grant select on public.topic_proposal_examples to anon, authenticated;
grant insert on public.topic_proposal_examples to authenticated;

create table public.topic_proposal_endorsements (
  proposal_id uuid not null references public.topic_proposals (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (proposal_id, user_id)
);

create index topic_proposal_endorsements_user_id_idx on public.topic_proposal_endorsements (user_id);

alter table public.topic_proposal_endorsements enable row level security;

create policy "topic proposal endorsements are publicly readable" on public.topic_proposal_endorsements
  for select to anon, authenticated using (true);
create policy "Users endorse others' open proposals" on public.topic_proposal_endorsements
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.topic_proposals p
      where p.id = proposal_id and p.status = 'open' and p.proposed_by <> (select auth.uid())
    )
  );
create policy "Users withdraw their own endorsements" on public.topic_proposal_endorsements
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.topic_proposal_endorsements from anon, authenticated;
grant select on public.topic_proposal_endorsements to anon, authenticated;
grant insert (proposal_id), delete on public.topic_proposal_endorsements to authenticated;

-- A user's own topic labels for a link. They count only toward that user's
-- taste and feed (user_topic_preferences, ranked_feed), where they replace a
-- shared link_topics label for the same topic; nobody else's ranking sees them.
create table public.link_topic_suggestions (
  link_id uuid not null references public.links (id) on delete cascade,
  topic_id extensions.ltree not null references public.topics (id) on update cascade on delete cascade,
  suggested_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  p real not null check (p > 0 and p <= 1),
  created_at timestamptz not null default now(),
  primary key (link_id, topic_id, suggested_by)
);

create index link_topic_suggestions_suggested_by_idx on public.link_topic_suggestions (suggested_by);
create index link_topic_suggestions_topic_id_idx on public.link_topic_suggestions using gist (topic_id);

create function public.check_link_topic_suggestion() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.topics t
    where t.id operator(extensions.<@) new.topic_id and t.id operator(extensions.<>) new.topic_id
  ) then
    raise exception 'links are tagged with leaf topics only; % has children', new.topic_id;
  end if;
  return new;
end;
$$;

create trigger link_topic_suggestions_check
  before insert or update on public.link_topic_suggestions
  for each row execute function public.check_link_topic_suggestion();

alter table public.link_topic_suggestions enable row level security;

create policy "link topic suggestions are publicly readable" on public.link_topic_suggestions
  for select to anon, authenticated using (true);
create policy "Users suggest labels as themselves" on public.link_topic_suggestions
  for insert to authenticated with check ((select auth.uid()) = suggested_by);
create policy "Users change their own suggestions" on public.link_topic_suggestions
  for update to authenticated
  using ((select auth.uid()) = suggested_by) with check ((select auth.uid()) = suggested_by);
create policy "Users remove their own suggestions" on public.link_topic_suggestions
  for delete to authenticated using ((select auth.uid()) = suggested_by);

revoke all on public.link_topic_suggestions from anon, authenticated;
grant select on public.link_topic_suggestions to anon, authenticated;
grant insert (link_id, topic_id, p), update (p), delete on public.link_topic_suggestions to authenticated;

-- Moderation, run by hand. Accepting creates the topic credited to its
-- proposer and turns the examples into shared labels; existing labels on the
-- parent (which may have been a leaf until now) are left as they are.
create function public.accept_topic_proposal(proposal uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  prop public.topic_proposals;
begin
  select * into prop from public.topic_proposals where id = proposal and status = 'open' for update;
  if not found then
    raise exception 'no open topic proposal %', proposal;
  end if;
  insert into public.topics (id, name, description, proposed_by)
  values (prop.topic_id, btrim(prop.name), btrim(prop.description), prop.proposed_by);
  insert into public.link_topics (link_id, topic_id, p, labeled_by)
  select e.link_id, prop.topic_id, e.p, 'manual'
  from public.topic_proposal_examples e
  where e.proposal_id = proposal
  on conflict do nothing;
  update public.topic_proposals set status = 'accepted', decided_at = now() where id = proposal;
end;
$$;

create function public.reject_topic_proposal(proposal uuid) returns void
language sql
security definer
set search_path = ''
as $$
  update public.topic_proposals set status = 'rejected', decided_at = now()
  where id = proposal and status = 'open';
$$;

revoke execute on function public.accept_topic_proposal(uuid) from public, anon, authenticated;
revoke execute on function public.reject_topic_proposal(uuid) from public, anon, authenticated;

-- Each voter's votes are now read against their own labels as well as the
-- shared ones (theirs win for the same link and topic).
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
join lateral (
  select shared.topic_id, shared.p
  from public.link_topics shared
  where shared.link_id = v.link_id
    and not exists (
      select 1 from public.link_topic_suggestions s
      where s.link_id = shared.link_id
        and s.topic_id operator(extensions.=) shared.topic_id
        and s.suggested_by = v.voter_id
    )
  union all
  select s.topic_id, s.p
  from public.link_topic_suggestions s
  where s.link_id = v.link_id and s.suggested_by = v.voter_id
) lt on true
cross join lateral generate_series(1, extensions.nlevel(lt.topic_id)) as depth(n)
group by v.voter_id, extensions.subpath(lt.topic_id, 0, depth.n);

-- ranked_feed: labels are the caller's effective ones (as above), and a topic
-- with no score of its own falls back to its nearest scored ancestor, not
-- just its parent, now that topics can be three levels deep.
create or replace function public.ranked_feed(as_of timestamptz, page_offset integer, page_size integer)
returns table (link_id uuid, rank double precision)
language sql
stable
security invoker
set search_path = ''
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
      * power(0.5, extract(epoch from as_of - l.created_at) / 3600 / 24) as rank
  from public.links l
  left join link_taste t on t.link_id = l.id
  left join link_votes v on v.link_id = l.id
  where l.created_at <= as_of
  order by rank desc, l.id desc
  offset page_offset
  limit page_size
$$;
