-- ap_posts: notes published by the site's ActivityPub actor (@seb@seb.now).
-- Inserting a row is publishing it: the trigger below asks the activitypub
-- edge function to deliver every undelivered post, as a signed Create(Note),
-- to each follower's inbox. The function claims a post by setting
-- delivered_at, so a post is delivered at most once. Written only via
-- service_role; publicly readable, since every post is public anyway.
create table public.ap_posts (
  id uuid primary key default gen_random_uuid(),
  content text not null check (length(btrim(content)) between 1 and 500),
  published_at timestamptz not null default now(),
  delivered_at timestamptz
);

alter table public.ap_posts enable row level security;

create policy "ap_posts are publicly readable"
  on public.ap_posts for select
  to anon, authenticated
  using (true);

revoke insert, update, delete, truncate on public.ap_posts from anon, authenticated;

create function public.ap_posts_request_delivery()
returns trigger
language plpgsql
set search_path = public, net
as $$
begin
  perform net.http_post(
    url := 'https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub/ap/deliver',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return null;
end;
$$;

create trigger ap_posts_request_delivery
  after insert on public.ap_posts
  for each statement
  execute function public.ap_posts_request_delivery();
