-- Tracks the discussion/lineage page a link was surfaced from (a Mastodon
-- status permalink, an HN item's comments page), separately from `url`,
-- which is the ultimate source (the article the post is about, when one
-- exists). Lets ingestion surface the external source as the clickable
-- link while keeping the originating thread around for a future
-- integrated comments view.
alter table public.links add column thread_url text;
