-- Ranked full-text search (already applied to the database; recorded here).
-- links.fts indexes title (weight A), host (B) and description (C): English and
-- French stemmed lexemes plus unstemmed 'simple' ones, all accent-folded with
-- fold_text, so "batteries" finds "battery" and "musee" finds "Musée".
alter table public.links add column if not exists fts tsvector generated always as (
  setweight(
    to_tsvector('english'::regconfig, public.fold_text(coalesce(title, ''))) ||
    to_tsvector('french'::regconfig,  public.fold_text(coalesce(title, ''))) ||
    to_tsvector('simple'::regconfig,  public.fold_text(coalesce(title, ''))), 'A') ||
  setweight(
    to_tsvector('simple'::regconfig, replace(coalesce(substring(url, '^[^:]+://(?:[^@/]*@)?(?:www\.)?([^/:?#]+)'), ''), '.', ' ')), 'B') ||
  setweight(
    to_tsvector('english'::regconfig, public.fold_text(coalesce(description, ''))) ||
    to_tsvector('french'::regconfig,  public.fold_text(coalesce(description, ''))) ||
    to_tsvector('simple'::regconfig,  public.fold_text(coalesce(description, ''))), 'C')
) stored;

create index if not exists links_fts_idx on public.links using gin (fts);

-- Ranked search: full-text hits + links tagged with entities named in the query
-- + substring match as a typo/partial-word fallback. Mild recency boost.
-- (Redefined in 20261015221000_feed_query_fulltext.sql on top of link_search_hits.)
create or replace function public.search_links(q text, max_results integer default 20, page_offset integer default 0)
returns table(link_id uuid, score real, matched_entities text[])
language sql
stable
set search_path to 'public', 'extensions'
as $$
  with input as (
    select
      public.fold_text(btrim(q)) as fq,
      replace(replace(replace(lower(btrim(q)), '\', '\\'), '%', '\%'), '_', '\_') as like_q,
      websearch_to_tsquery('english', public.fold_text(q))
        || websearch_to_tsquery('french', public.fold_text(q))
        || websearch_to_tsquery('simple', public.fold_text(q)) as tsq
  ),
  words as (
    select distinct w
    from input, regexp_split_to_table(input.fq, '[^a-z0-9]+') w
    where length(w) >= 3
  ),
  ents as (
    select e.id, e.name from entities e, input i where public.fold_text(e.name) = i.fq
    union
    select e.id, e.name from entities e join words w on public.fold_text(e.name) = w.w
  ),
  hits as (
    select l.id, ts_rank_cd(l.fts, i.tsq, 1)::real as r, null::text as name
    from links l, input i
    where l.fts @@ i.tsq
    union all
    select le.link_id, (0.3 * le.p * case when le.found_in = 'title' then 1 else 0.5 end)::real, en.name
    from link_entities le join ents en on en.id = le.entity_id
    union all
    select l.id, 0.02::real, null
    from links l, input i
    where length(i.like_q) >= 3 and l.search_text like '%' || i.like_q || '%'
  )
  select
    h.id,
    (sum(h.r) * (0.75 + 0.25 * power(0.5, extract(epoch from now() - l.created_at) / 86400 / 60)))::real,
    coalesce(array_agg(distinct h.name) filter (where h.name is not null), '{}')
  from hits h join links l on l.id = h.id
  group by h.id, l.created_at
  order by 2 desc, l.created_at desc, h.id desc
  offset greatest(page_offset, 0)
  limit least(greatest(max_results, 1), 50)
$$;

grant execute on function public.search_links(text, integer, integer) to anon, authenticated;
