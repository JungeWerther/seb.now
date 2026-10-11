-- Every link labelled with a topic or one of its children, newest first, for
-- the topic's page (/t/<path>). Paged like entity_links; `topic` is text since
-- PostgREST passes RPC arguments as JSON strings.
create function public.topic_links(topic text, max_results integer default 30, page_offset integer default 0)
returns table (link_id uuid)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select l.id
  from links l
  where exists (select 1 from link_topics lt where lt.link_id = l.id and lt.topic_id <@ topic::ltree)
  order by l.created_at desc, l.id desc
  offset page_offset
  limit max_results
$$;

create function public.topic_link_count(topic text)
returns integer
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select count(distinct lt.link_id)::integer from link_topics lt where lt.topic_id <@ topic::ltree
$$;

grant execute on function public.topic_links(text, integer, integer) to anon, authenticated;
grant execute on function public.topic_link_count(text) to anon, authenticated;
