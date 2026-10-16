-- Entities tagged in the search box filter the results, all of them at once:
-- "tim fernholz san francisco" shows only links about both, rather than links
-- whose title happens to contain all four words (none) with either entity's
-- links ranked first.
--
-- `required` is a JSON array of groups, one per tagged name:
--   [{"ids": ["<uuid>", ...], "words": ["tim", "fernholz"]}, ...]
-- A link must satisfy every group (AND across names). It satisfies a group by
-- mentioning any of its entities (one name can have several senses, e.g. an
-- organisation and its building) or, for links entity-extract hasn't read yet,
-- by having every one of the name's words in its search_text (OR within a name).
-- `entities` stays a reorder only, for the other suggestions.
alter function public.feed_query(text, text, text, timestamptz, integer, integer, uuid[]) rename to feed_query_old;

create function public.feed_query(
  sort text,
  topic text,
  search text,
  as_of timestamptz,
  page_offset integer default 0,
  page_size integer default 30,
  entities uuid[] default null,
  required jsonb default null
)
returns table (link_id uuid, rank double precision)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  words text[] := array(
    select replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')
    from regexp_split_to_table(fold_text(coalesce(search, '')), '\s+') w
    where w <> ''
  );
  groups jsonb := case when jsonb_typeof(required) = 'array' then required else '[]'::jsonb end;
begin
  if sort not in ('for_you', 'latest', 'top', 'discussed') then
    raise exception 'unknown sort %', sort using errcode = '22023';
  end if;
  return query
  with required_groups as (
    select
      array(select jsonb_array_elements_text(coalesce(g -> 'ids', '[]'))::uuid) as ids,
      array(
        select replace(replace(replace(fold_text(w), '\', '\\'), '%', '\%'), '_', '\_')
        from jsonb_array_elements_text(coalesce(g -> 'words', '[]')) w
        where w <> ''
      ) as words
    from jsonb_array_elements(groups) g
  ),
  matching as (
    select l.id, l.created_at,
      coalesce(cardinality(entities), 0) > 0 and exists (
        select 1 from link_entities le where le.link_id = l.id and le.entity_id = any(entities)
      ) as mentions
    from links l
    where l.created_at <= as_of
      and (topic is null or exists (
        select 1 from link_topics lt where lt.link_id = l.id and lt.topic_id <@ topic::ltree
      ))
      and not exists (select 1 from unnest(words) w where fold_text(l.search_text) not like '%' || w || '%')
      and not exists (
        select 1 from required_groups rg
        where not exists (
            select 1 from link_entities le where le.link_id = l.id and le.entity_id = any(rg.ids)
          )
          and (
            cardinality(rg.words) = 0
            or exists (select 1 from unnest(rg.words) w where fold_text(l.search_text) not like '%' || w || '%')
          )
      )
  ),
  scored as (
    select m.id, m.created_at, m.mentions,
      case sort
        when 'latest' then extract(epoch from m.created_at)::double precision
        when 'top' then (
          select coalesce(sum(v.value), 0)::double precision from votes v where v.link_id = m.id
        )
        when 'discussed' then (
          select count(*)::double precision from replies r where r.link_id = m.id
        )
      end as rank
    from matching m
    where sort <> 'for_you'
    union all
    select m.id, m.created_at, m.mentions, r.rank
    from matching m
    join ranked_feed(as_of, 0, 2147483647) r on r.link_id = m.id
    where sort = 'for_you'
  )
  select s.id, s.rank
  from scored s
  order by s.mentions desc, s.rank desc, s.created_at desc, s.id desc
  offset page_offset
  limit page_size;
end
$$;

grant execute on function public.feed_query(text, text, text, timestamptz, integer, integer, uuid[], jsonb) to anon, authenticated;
