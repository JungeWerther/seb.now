-- The site actor's posts become ordinary links, and fediverse reactions to
-- them become ordinary votes and replies.
--
-- remote_actors: fediverse accounts that liked, boosted or replied to one of
-- the site's posts. Written only by the activitypub edge function
-- (service_role); publicly readable so the page can show a reply's handle.
create table public.remote_actors (
  id uuid primary key default gen_random_uuid(),
  actor_url text not null unique,
  handle text not null check (char_length(handle) between 1 and 200),
  created_at timestamptz not null default now()
);

alter table public.remote_actors enable row level security;

create policy "remote actors are publicly readable"
  on public.remote_actors for select
  to anon, authenticated
  using (true);

revoke insert, update, delete, truncate on public.remote_actors from anon, authenticated;

-- A vote or reply now comes from exactly one of a local profile or a remote
-- actor. The existing RLS policies compare auth.uid() to voter_id/author_id,
-- so rows with a remote actor stay writable only by service_role.
alter table public.votes
  alter column voter_id drop not null,
  add column remote_actor_id uuid references public.remote_actors(id) on delete cascade,
  add constraint votes_one_voter check (num_nonnulls(voter_id, remote_actor_id) = 1),
  add constraint votes_link_id_remote_actor_id_key unique (link_id, remote_actor_id);

-- ap_object_id is the reply's own fediverse id, so a redelivered reply is
-- stored once and a Delete of it can find the row.
alter table public.replies
  alter column author_id drop not null,
  add column remote_actor_id uuid references public.remote_actors(id) on delete cascade,
  add column ap_object_id text unique,
  add constraint replies_one_author check (num_nonnulls(author_id, remote_actor_id) = 1);

-- ap_posts now only marks which local links are federated posts and whether
-- they've been delivered; their text and time live on the links row. Existing
-- posts keep their id as the link id, so their note ids
-- (https://seb.now/ap/notes?id=<id>) stay the same.
insert into public.links (id, url, title, origin, author, created_at)
select id, 'https://seb.now/p/' || id, content, 'local', '@seb@seb.now', published_at
from public.ap_posts;

alter table public.ap_posts rename column id to link_id;
alter table public.ap_posts
  drop column content,
  drop column published_at,
  alter column link_id drop default,
  add constraint ap_posts_link_id_fkey foreign key (link_id) references public.links(id) on delete cascade;

-- Publishing a post: one call inserts the link and marks it for delivery; the
-- ap_posts insert trigger then sends it to followers.
create function public.publish_post(content text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.links (id, url, title, origin, author)
  values (new_id, 'https://seb.now/p/' || new_id, content, 'local', '@seb@seb.now');
  insert into public.ap_posts (link_id) values (new_id);
  return new_id;
end;
$$;

revoke execute on function public.publish_post(text) from public, anon, authenticated;
