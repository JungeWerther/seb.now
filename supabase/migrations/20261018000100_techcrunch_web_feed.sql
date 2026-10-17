-- TechCrunch becomes an ordinary followed feed, read by web-feed-ingest, and
-- its own techcrunch-ingest function is retired.

-- The function is deleted by hand from the dashboard once this has applied.
select cron.unschedule(jobid) from cron.job where jobname = 'techcrunch-ingest';

-- sources_sync_entity creates the "TechCrunch" source entity
-- (entity.source.web_feed) and tags every link already on techcrunch.com with
-- it, by host. web-feed-ingest upserts on url, so links already stored keep
-- their id, votes and replies.
insert into public.sources (kind, identifier, label) values
  ('web_feed', 'https://techcrunch.com/feed/', 'TechCrunch: startups and technology news')
on conflict (kind, identifier) do nothing;
