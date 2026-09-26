-- A YouTube video's og:image is its thumbnail at a fixed address, but
-- YouTube doesn't serve og:image to the ingest functions' data-centre
-- requests, so links to videos (e.g. from Hacker News) arrived imageless.
-- Fill any YouTube video link saved without an image with hqdefault.jpg
-- (4:3 with letterbox bars on 16:9 videos, which the page's 16:9 cover crop
-- trims), whichever ingest wrote it.
create function public.youtube_video_id(url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select substring(
    url from '^https?://(?:[a-z0-9-]+\.)?(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})'
  )
$$;

create function public.links_fill_youtube_thumbnail()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  video_id text := public.youtube_video_id(new.url);
begin
  if new.image_url is null and video_id is not null then
    new.image_url := 'https://i.ytimg.com/vi/' || video_id || '/hqdefault.jpg';
  end if;
  return new;
end
$$;

create trigger links_fill_youtube_thumbnail
before insert or update of url, image_url on public.links
for each row execute function public.links_fill_youtube_thumbnail();

update public.links
set image_url = 'https://i.ytimg.com/vi/' || public.youtube_video_id(url) || '/hqdefault.jpg'
where image_url is null and public.youtube_video_id(url) is not null;
