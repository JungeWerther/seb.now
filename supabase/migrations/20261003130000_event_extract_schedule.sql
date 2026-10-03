-- event-extract: every 10 minutes, up to 10 links a run, after entity-extract
-- has tagged them (the venue is picked among their place entities). Links with
-- no date later than the day before they were published make no Jev call.
select cron.schedule(
  'event-extract',
  '4-59/10 * * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/event-extract',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
