-- place-resolve: every 10 minutes, up to 20 places a run, most mentioned
-- first, until every place has been looked up on Wikidata once; after that it
-- only picks up new places (and the parents it creates).
select cron.schedule(
  'place-resolve',
  '7-59/10 * * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/place-resolve',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
