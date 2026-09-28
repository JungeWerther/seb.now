-- A reader's comment on any link now goes to the fediverse, not only replies
-- on the site's own posts: on a federated post it's still a reply, on any
-- other link it's a post of the reader's own that shares the link. The claim
-- returns what the edge function needs to tell the two apart and to write
-- the link into the post.
drop function public.claim_federated_replies(text, text, integer);

create function public.claim_federated_replies(handle_pattern text, reserved_handle text, per_hour integer)
returns table (
  id uuid, link_id uuid, author_id uuid, handle text, body text, created_at timestamptz, ap_state text,
  link_url text, link_title text, is_post boolean
)
language sql
set search_path = public
as $$
  update public.replies r
  set ap_state = case
    when pr.handle ~ handle_pattern
      and pr.handle <> reserved_handle
      and (select count(*) from public.replies s
           where s.author_id = r.author_id and s.ap_state = 'sent'
             and s.created_at > now() - interval '1 hour') < per_hour
    then 'sent'
    else 'local'
  end
  from public.profiles pr, public.links l
  where pr.id = r.author_id and l.id = r.link_id and r.ap_state is null
  returning r.id, r.link_id, r.author_id, pr.handle, r.body, r.created_at, r.ap_state,
    l.url, l.title, exists (select 1 from public.ap_posts p where p.link_id = r.link_id)
$$;

revoke execute on function public.claim_federated_replies(text, text, integer) from public, anon, authenticated;
