-- One level of the topic taxonomy: the direct children of `parent` (the
-- top-level topics when it's null), each with its own child count so a caller
-- can browse down. The whole taxonomy is over PostgREST's max-rows cap, and
-- PostgREST has no ltree operators to filter a subtree with.
create function public.topic_children(parent extensions.ltree default null)
returns table (id text, name text, description text, proposed_by text, children bigint)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    t.id::text,
    t.name,
    t.description,
    case when t.proposed_by is not null then coalesce(p.handle, 'anonymous') end,
    (select count(*) from topics c where c.id <@ t.id and nlevel(c.id) = nlevel(t.id) + 1)
  from topics t
  left join profiles p on p.id = t.proposed_by
  where case
    when parent is null then nlevel(t.id) = 1
    else t.id <@ parent and nlevel(t.id) = nlevel(parent) + 1
  end
  order by t.id
$$;

grant execute on function public.topic_children(extensions.ltree) to anon, authenticated;
