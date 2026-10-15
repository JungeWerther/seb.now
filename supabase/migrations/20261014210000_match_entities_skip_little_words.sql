-- An entity's little name words ("of", "the", "de") no longer count toward the
-- half of its name the typed words must cover: "juggalos" covered only 1 of
-- the 4 words of "Gathering of the Juggalos", so it was never suggested, while
-- "openai" did cover half of "OpenAI DevDay". Candidate names are folded with
-- fold_text too, so "cafe" finds an entity named "Café".
create or replace function public.match_entities(words text[], partial text default null, max_results integer default 4)
returns table(id uuid, name text, kind text, posts bigint)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with typed as (
    select w, false as is_partial
    from (select regexp_replace(lower(w), '[^a-z0-9]', '', 'g') as w from unnest(words[1:12]) w) t
    where w <> ''
    union all
    select regexp_replace(lower(partial), '[^a-z0-9]', '', 'g'), true
    where length(regexp_replace(lower(coalesce(partial, '')), '[^a-z0-9]', '', 'g')) >= 2
  ),
  candidates as (
    select distinct e.id, e.name, e.kind
    from typed t
    join entities e on fold_text(e.name) like '%' || t.w || '%'
    where length(t.w) >= 3
    union
    select e.id, e.name, e.kind
    from typed t
    join entities e on fold_text(e.name) = t.w or fold_text(e.name) like t.w || ' %'
    where length(t.w) < 3
  ),
  scored as (
    select c.id, c.name, c.kind, cardinality(nw.words) as n,
      (select count(*) from unnest(nw.words) x
        where exists (
          select 1 from typed t
          where x = t.w
            or (t.is_partial and x like t.w || '%')
            or (length(t.w) >= 3 and (x in (t.w || 's', t.w || 'es') or t.w in (x || 's', x || 'es')))
        )) as hits
    from candidates c,
    lateral (
      select array(
        select x from regexp_split_to_table(lower(unaccent(c.name)), '[^a-z0-9]+') x
        where x <> '' and x <> all (array['a', 'an', 'and', 'the', 'of', 'on', 'in', 'for', 'to', 'at', 'by',
          'with', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'y', 'el', 'von', 'van', 'der', 'den'])
      ) as words
    ) nw
  )
  select s.id, s.name, s.kind, (select count(*) from link_entities le where le.entity_id = s.id) as posts
  from scored s
  where s.n > 0 and s.hits * 2 >= s.n
  order by s.hits::float / s.n desc, posts desc, length(s.name), s.id
  limit least(max_results, 10)
$$;

grant execute on function public.match_entities(text[], text, integer) to anon, authenticated;
