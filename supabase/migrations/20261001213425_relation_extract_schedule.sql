select cron.schedule(
  'relation-extract',
  '2-59/10 * * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/relation-extract',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
