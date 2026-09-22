create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Full (non-partial) unique index: NULL never collides with NULL under
-- uniqueness, so local links (fediverse_post_uri is null) are unaffected,
-- and PostgREST's upsert(onConflict:) can only resolve against a plain
-- index - it doesn't add the WHERE predicate a partial index would need.
create unique index links_fediverse_post_uri_idx on public.links (fediverse_post_uri);
