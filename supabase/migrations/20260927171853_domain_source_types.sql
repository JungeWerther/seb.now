-- domain_source_types: which domains count as mainstream media or YouTube
-- long-form, so the list is data rather than a set in constants.py. A domain
-- with no row is a direct link. Public-read, service_role-write; site.py reads
-- it at build time to tag each article's SourceType.
create table public.domain_source_types (
  domain text primary key check (domain ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'),
  source_type text not null check (source_type in ('mainstream_media', 'youtube_longform')),
  created_at timestamptz not null default now()
);

alter table public.domain_source_types enable row level security;

create policy "domain source types are publicly readable"
  on public.domain_source_types for select
  to anon, authenticated
  using (true);

revoke insert, update, delete, truncate on public.domain_source_types from anon, authenticated;

insert into public.domain_source_types (domain, source_type) values
  ('nytimes.com', 'mainstream_media'),
  ('washingtonpost.com', 'mainstream_media'),
  ('wsj.com', 'mainstream_media'),
  ('bbc.com', 'mainstream_media'),
  ('bbc.co.uk', 'mainstream_media'),
  ('cnn.com', 'mainstream_media'),
  ('reuters.com', 'mainstream_media'),
  ('apnews.com', 'mainstream_media'),
  ('theguardian.com', 'mainstream_media'),
  ('npr.org', 'mainstream_media'),
  ('ft.com', 'mainstream_media'),
  ('bloomberg.com', 'mainstream_media'),
  ('foxnews.com', 'mainstream_media'),
  ('nbcnews.com', 'mainstream_media'),
  ('cbsnews.com', 'mainstream_media'),
  ('abcnews.go.com', 'mainstream_media'),
  ('usatoday.com', 'mainstream_media'),
  ('politico.com', 'mainstream_media'),
  ('axios.com', 'mainstream_media'),
  ('time.com', 'mainstream_media'),
  ('newsweek.com', 'mainstream_media'),
  ('economist.com', 'mainstream_media'),
  ('youtube.com', 'youtube_longform'),
  ('youtu.be', 'youtube_longform');
