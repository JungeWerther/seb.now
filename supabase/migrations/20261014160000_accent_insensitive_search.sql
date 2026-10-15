-- Search ignores accents as well as case: "zurich" finds "Zürich", "cafe"
-- finds "café". fold_text lowercases and strips diacritics; feed_query folds
-- both the typed words and each link's search_text with it at query time
-- (search_text itself stays lowercase-only, so its trigram index no longer
-- serves feed_query; fine at thousands of links).
create function public.fold_text(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, t)) $$;

create or replace function public.feed_query(
  sort text,
  topic text,
  search text,
  as_of timestamptz,
  page_offset integer default 0,
  page_size integer default 30
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
begin
  if sort not in ('for_you', 'latest', 'top', 'discussed') then
    raise exception 'unknown sort %', sort using errcode = '22023';
  end if;
  return query
  with matching as (
    select l.id, l.created_at
    from links l
    where l.created_at <= as_of
      and (topic is null or exists (
        select 1 from link_topics lt where lt.link_id = l.id and lt.topic_id <@ topic::ltree
      ))
      and not exists (select 1 from unnest(words) w where fold_text(l.search_text) not like '%' || w || '%')
  ),
  scored as (
    select m.id, m.created_at,
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
    select m.id, m.created_at, r.rank
    from matching m
    join ranked_feed(as_of, 0, 2147483647) r on r.link_id = m.id
    where sort = 'for_you'
  )
  select s.id, s.rank
  from scored s
  order by s.rank desc, s.created_at desc, s.id desc
  offset page_offset
  limit page_size;
end
$$;

