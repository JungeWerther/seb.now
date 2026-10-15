-- One page of related_links with each link's feed row (the page's FEED_SELECT
-- shape) in the same response, so the focused view's related list costs one
-- round trip instead of an rpc followed by a links fetch by id.
create function public.related_feed(link uuid, max_results integer default 10, page_offset integer default 0)
returns table(link_id uuid, score double precision, shared_entities text[], shared_topics text[], link_row jsonb)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select r.link_id, r.score, r.shared_entities, r.shared_topics,
    jsonb_build_object(
      'id', l.id,
      'title', l.title,
      'url', l.url,
      'image_url', l.image_url,
      'author', l.author,
      'created_at', l.created_at,
      'link_topics', coalesce((
        select jsonb_agg(jsonb_build_object('p', lt.p, 'topics', jsonb_build_object('id', t.id, 'name', t.name)))
        from link_topics lt
        join topics t on t.id = lt.topic_id
        where lt.link_id = l.id
      ), '[]'::jsonb),
      'link_entities', coalesce((
        select jsonb_agg(jsonb_build_object('p', le.p, 'entities', jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind)))
        from link_entities le
        join entities e on e.id = le.entity_id
        where le.link_id = l.id
      ), '[]'::jsonb)
    )
  from related_links(link, max_results, page_offset) with ordinality as r(link_id, score, shared_entities, shared_topics, n)
  join links l on l.id = r.link_id
  order by r.n
$$;

grant execute on function public.related_feed(uuid, integer, integer) to anon, authenticated;
