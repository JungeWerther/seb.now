-- sources: the accounts and channels the ingest functions follow, as data
-- rather than lists in their code, so following or dropping one is a row
-- change with no redeploy. Public-read (which sources feed the site is part
-- of the open algorithm), service_role-write like links and topics.
-- identifier is validated per kind because the ingest functions build fetch
-- URLs from it: a Mastodon instance becomes the request host.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('youtube_channel', 'mastodon_account')),
  identifier text not null,
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, identifier),
  constraint sources_identifier_format check (
    case kind
      when 'youtube_channel' then identifier ~ '^UC[A-Za-z0-9_-]{22}$'
      when 'mastodon_account' then identifier ~ '^[A-Za-z0-9_]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
    end
  )
);

alter table public.sources enable row level security;

create policy "sources are publicly readable"
  on public.sources for select
  to anon, authenticated
  using (true);

insert into public.sources (kind, identifier, label) values
  ('youtube_channel', 'UC-AQKm7HUNMmxjdS371MSwg', 'Channel 5 with Andrew Callaghan'),
  ('youtube_channel', 'UCLIYhydrnsWMDyJXacaj2Jg', 'no cap on god (Lionel McGloin)'),
  ('mastodon_account', 'DAIR@dair-community.social', 'DAIR: AI ethics and policy'),
  ('mastodon_account', 'colossal@mastodon.art', 'Colossal: contemporary art and visual culture');

revoke insert, update, delete, truncate on public.sources from anon, authenticated;
