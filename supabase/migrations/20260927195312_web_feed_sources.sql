-- web_feed sources: any site's own RSS or Atom feed (a blog, a newsletter),
-- read by web-feed-ingest. The identifier is the feed URL itself, https only,
-- since the ingest fetches it as-is.
alter table public.sources drop constraint sources_kind_check;
alter table public.sources add constraint sources_kind_check
  check (kind in ('youtube_channel', 'mastodon_account', 'web_feed'));

alter table public.sources drop constraint sources_identifier_format;
alter table public.sources add constraint sources_identifier_format check (
  case kind
    when 'youtube_channel' then identifier ~ '^UC[A-Za-z0-9_-]{22}$'
    when 'mastodon_account' then identifier ~ '^[A-Za-z0-9_]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
    when 'web_feed' then identifier ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]+)?(/[^[:space:]]*)?$'
  end
);
