-- ical_feed sources: public event calendars (iCalendar .ics), read by the
-- ical-ingest function. Each upcoming event becomes a link to its own page,
-- with its dates written straight to link_events as labeled_by 'ical' (the
-- calendar states them, so event-extract isn't asked to guess).
--
-- The kind and identifier checks are restated in full: they also carry
-- web_feed, which was added to the live database outside a migration.

alter table public.sources
  drop constraint if exists sources_kind_check,
  drop constraint if exists sources_identifier_format;

alter table public.sources
  add constraint sources_kind_check
    check (kind in ('youtube_channel', 'mastodon_account', 'web_feed', 'ical_feed')),
  add constraint sources_identifier_format check (
    case kind
      when 'youtube_channel' then identifier ~ '^UC[A-Za-z0-9_-]{22}$'
      when 'mastodon_account' then identifier ~ '^[A-Za-z0-9_]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
      when 'web_feed' then identifier ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]+)?(/[^[:space:]]*)?$'
      when 'ical_feed' then identifier ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]+)?(/[^[:space:]]*)?$'
    end
  );

alter table public.link_events
  drop constraint if exists link_events_labeled_by_check;

alter table public.link_events
  add constraint link_events_labeled_by_check
    check (labeled_by in ('jev', 'json_ld', 'manual', 'ical'));

-- Luma: the Paris city page's calendar, and Paris communities' own.
insert into public.sources (kind, identifier, label) values
  ('ical_feed', 'https://api.lu.ma/ics/get?entity=discover&id=discplace-NdLrh1xJfeotJZC', 'Luma: what''s happening in Paris'),
  ('ical_feed', 'https://api.lu.ma/ics/get?entity=calendar&id=cal-3OpKEgfnjQ1Ps6z', 'Luma: The Offline Club Paris'),
  ('ical_feed', 'https://api.lu.ma/ics/get?entity=calendar&id=cal-LCVoRrj9QblFQOL', 'Luma: Plug and Play France (startup events)')
on conflict (kind, identifier) do nothing;

-- Every 6 hours, 20 minutes past, between web-feed-ingest and the others.
select cron.schedule(
  'ical-ingest',
  '20 1-23/6 * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/ical-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
