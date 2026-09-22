-- Adds a third origin value: 'feed' for content pulled from an external
-- feed/API (HN, TechCrunch) - distinct from 'local' (a user's own
-- submission) and 'fediverse' (a followed account's post).
alter table public.links drop constraint links_source_type_check;
alter table public.links add constraint links_origin_check check (origin in ('local', 'fediverse', 'feed'));

-- Lets hn-ingest/techcrunch-ingest upsert(onConflict: 'url') idempotently.
create unique index links_url_idx on public.links (url);
