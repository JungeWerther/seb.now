-- The site's search (feed_query) uses the same ranked matcher as the MCP's
-- search_links: link_search_hits(search) returns every matching link with a
-- relevance score and the entities that pulled it in. A link matches when it
--   - matches the full-text query on links.fts (title > host > description,
--     English/French stemming, accents ignored, websearch syntax: "phrases",
--     -exclude, or), or
--   - is tagged with an entity whose folded name is the whole query, so "tsmc"
--     finds links that never say "TSMC", or
--   - holds every typed word in fold_text(search_text) — the previous rule, kept
--     as the fallback for partial words, so nothing that matched before stops
--     matching.
-- An entity named by just one of several typed words (OpenAI in "openai
-- agents") only boosts links that already match; it doesn't pull in every
-- link tagged with it.
-- feed_query keeps its sort orders among the matches, except that for_you with
-- search words orders by relevance (score) instead of ranked_feed's rank.
create or replace function public.link_search_hits(search text)
returns table(link_id uuid, score real, matched_entities text[])
language sql
stable
security invoker
set search_path to 'public', 'extensions'
as $$
  with input as (
    select
      fold_text(btrim(coalesce(search, ''))) as fq,
      websearch_to_tsquery('english', fold_text(coalesce(search, '')))
        || websearch_to_tsquery('french', fold_text(coalesce(search, '')))
        || websearch_to_tsquery('simple', fold_text(coalesce(search, ''))) as tsq
  ),
  typed as (
    select array(
      select replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')
      from input, regexp_split_to_table(input.fq, '\s+') w
      where w <> ''
    ) as words
  ),
  name_words as (
    select distinct w
    from input, regexp_split_to_table(input.fq, '[^a-z0-9]+') w
    where length(w) >= 3
  ),
  ents as (
    select e.id, e.name, bool_or(whole) as whole
    from (
      select e.id, e.name, true as whole from entities e, input i where i.fq <> '' and fold_text(e.name) = i.fq
      union all
      select e.id, e.name, false from entities e join name_words w on fold_text(e.name) = w.w
    ) e
    group by e.id, e.name
  ),
  hits as (
    select l.id, ts_rank_cd(l.fts, i.tsq, 1)::real as r, null::text as name, true as qualifies
    from links l, input i
    where l.fts @@ i.tsq
    union all
    select le.link_id, (0.3 * le.p * case when le.found_in = 'title' then 1 else 0.5 end)::real, en.name, en.whole
    from link_entities le join ents en on en.id = le.entity_id
    union all
    select l.id, 0.02::real, null, true
    from links l, typed t
    where cardinality(t.words) > 0
      and not exists (select 1 from unnest(t.words) w where fold_text(l.search_text) not like '%' || w || '%')
  )
  select
    h.id,
    (sum(h.r) * (0.75 + 0.25 * power(0.5, extract(epoch from now() - l.created_at) / 86400 / 60)))::real,
    coalesce(array_agg(distinct h.name) filter (where h.name is not null), '{}')
  from hits h join links l on l.id = h.id
  group by h.id, l.created_at
  having bool_or(h.qualifies)
$$;

grant execute on function public.link_search_hits(text) to anon, authenticated;

create or replace function public.search_links(q text, max_results integer default 20, page_offset integer default 0)
returns table(link_id uuid, score real, matched_entities text[])
language sql
stable
security invoker
set search_path to 'public', 'extensions'
as $$
  select h.link_id, h.score, h.matched_entities
  from link_search_hits(q) h join links l on l.id = h.link_id
  order by h.score desc, l.created_at desc, h.link_id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 1), 50)
$$;

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
  searching boolean := btrim(coalesce(search, '')) <> '';
begin
  if sort not in ('for_you', 'latest', 'top', 'discussed') then
    raise exception 'unknown sort %', sort using errcode = '22023';
  end if;
  return query
  with hits as (
    select h.link_id, h.score from link_search_hits(search) h where searching
  ),
  matching as (
    select l.id, l.created_at, h.score
    from links l
    left join hits h on h.link_id = l.id
    where l.created_at <= as_of
      and (topic is null or exists (
        select 1 from link_topics lt where lt.link_id = l.id and lt.topic_id <@ topic::ltree
      ))
      and (not searching or h.link_id is not null)
  ),
  scored as (
    select m.id, m.created_at,
      case sort
        when 'for_you' then m.score::double precision
        when 'latest' then extract(epoch from m.created_at)::double precision
        when 'top' then (
          select coalesce(sum(v.value), 0)::double precision from votes v where v.link_id = m.id
        )
        when 'discussed' then (
          select count(*)::double precision from replies r where r.link_id = m.id
        )
      end as rank
    from matching m
    where sort <> 'for_you' or searching
    union all
    select m.id, m.created_at, r.rank
    from matching m
    join ranked_feed(as_of, 0, 2147483647) r on r.link_id = m.id
    where sort = 'for_you' and not searching
  )
  select s.id, s.rank
  from scored s
  order by s.rank desc, s.created_at desc, s.id desc
  offset page_offset
  limit page_size;
end
$$;
