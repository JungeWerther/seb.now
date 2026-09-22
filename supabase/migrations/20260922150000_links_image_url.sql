-- Preview thumbnail for a link, populated by fediverse-ingest when
-- Mastodon's own card doesn't carry one (og:image, or the page's first
-- <img>, scraped from the target page). HN/TechCrunch links leave this
-- null - their ingest functions don't peek at target pages.
alter table public.links add column image_url text;
