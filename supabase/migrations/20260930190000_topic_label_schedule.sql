-- topic-label: Jev labels links that have no topics yet with leaf topics
-- (labeled_by = 'jev'), up to 60 per run. Every 3 hours at :55, so each run
-- follows the ingests before it. The function is deployed with verify_jwt on;
-- the cron sends the anon key, read like the URL from app_settings
-- (`anon_key`, filled per environment, never by a migration).
select cron.schedule(
  'topic-label',
  '55 */3 * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/topic-label',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
