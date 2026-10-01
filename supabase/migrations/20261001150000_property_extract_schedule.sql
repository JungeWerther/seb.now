-- property-extract: every 10 minutes, offset from relation-extract's :x2, up to
-- 100 links a run. Only links whose titles describe an entity cost Jev calls.
select cron.schedule(
  'property-extract',
  '7-59/10 * * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/property-extract',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
