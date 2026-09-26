-- The page loads the feed a page at a time (keyset on created_at, id - one
-- ingest upsert stamps every row with the same now(), so id breaks ties) and
-- searches server-side with a substring match over title + host.
create extension if not exists pg_trgm with schema extensions;

create index links_created_at_id_idx on public.links (created_at desc, id desc);

-- Mirrors the page's old client-side filter: the title plus the url's host
-- without "www.", lowercased.
alter table public.links
  add column search_text text generated always as (
    lower(
      title || ' ' || coalesce(substring(url from '^[^:]+://(?:[^@/]*@)?(?:www\.)?([^/:?#]+)'), '')
    )
  ) stored;

create index links_search_text_trgm_idx on public.links using gin (search_text extensions.gin_trgm_ops);
