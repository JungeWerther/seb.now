-- The original TechCrunch/HN seed rows were hand-picked once via a web
-- search, tagged 'local' for lack of a better bucket at the time. Now that
-- hn-ingest/techcrunch-ingest exist, that's really 'feed' content - same
-- category, just picked by hand instead of by cron. Not deleted: three of
-- these rows already carry real votes, and their URLs happen not to be in
-- today's live top lists, so a delete+reingest would have orphaned that
-- vote history for no reason.
update public.links set origin = 'feed' where origin = 'local';
