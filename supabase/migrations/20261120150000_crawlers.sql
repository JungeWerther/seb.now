-- Crawlers read the site; they don't send signals.
--
--   crawler_agents            which user agents are crawlers (a token each, matched
--                             case-insensitively anywhere in the user agent)
--   is_crawler(user_agent)    whether a user agent names one
--   request_is_crawler()      whether the current PostgREST request comes from one
--   "crawlers send no …"      restrictive insert policies on link_impressions,
--                             link_visits and votes, the backstop for a crawler
--                             that runs the page script past its own check
--   crawler_accounts          anonymous accounts whose first session was a crawler
--                             (service_role only), so stats can leave them out;
--                             their rows are kept
--
-- The page reads crawler_agents at build time and skips its anonymous sign-in
-- for a crawler, which then reads the same pre-rendered and ranked feed as
-- anyone logged out.

create table public.crawler_agents (
  token text primary key check (token = lower(token) and length(token) between 3 and 64),
  operator text not null check (length(operator) between 1 and 64),
  purpose text not null check (purpose in ('search', 'ai', 'seo', 'social', 'audit')),
  created_at timestamptz not null default now()
);

comment on table public.crawler_agents is
  'User-agent tokens of crawlers. The page skips its anonymous session for them, and signal tables refuse their inserts.';

alter table public.crawler_agents enable row level security;
create policy "crawler agents are publicly readable" on public.crawler_agents
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.crawler_agents from anon, authenticated;

-- Named crawlers only, never a generic client ("node", "curl", "python"): the
-- Edge Functions and scripts write through PostgREST with those.
insert into public.crawler_agents (token, operator, purpose) values
  ('googlebot', 'Google', 'search'),
  ('googleother', 'Google', 'search'),
  ('google-inspectiontool', 'Google', 'search'),
  ('storebot-google', 'Google', 'search'),
  ('adsbot-google', 'Google', 'search'),
  ('google-extended', 'Google', 'ai'),
  ('bingbot', 'Microsoft', 'search'),
  ('applebot', 'Apple', 'search'),
  ('duckduckbot', 'DuckDuckGo', 'search'),
  ('baiduspider', 'Baidu', 'search'),
  ('yandexbot', 'Yandex', 'search'),
  ('oai-searchbot', 'OpenAI', 'ai'),
  ('gptbot', 'OpenAI', 'ai'),
  ('chatgpt-user', 'OpenAI', 'ai'),
  ('claudebot', 'Anthropic', 'ai'),
  ('claude-searchbot', 'Anthropic', 'ai'),
  ('claude-user', 'Anthropic', 'ai'),
  ('perplexitybot', 'Perplexity', 'ai'),
  ('perplexity-user', 'Perplexity', 'ai'),
  ('ccbot', 'Common Crawl', 'ai'),
  ('bytespider', 'ByteDance', 'ai'),
  ('meta-externalagent', 'Meta', 'ai'),
  ('meta-webindexer', 'Meta', 'search'),
  ('facebookexternalhit', 'Meta', 'social'),
  ('twitterbot', 'X', 'social'),
  ('linkedinbot', 'LinkedIn', 'social'),
  ('slackbot', 'Slack', 'social'),
  ('discordbot', 'Discord', 'social'),
  ('ahrefsbot', 'Ahrefs', 'seo'),
  ('semrushbot', 'Semrush', 'seo'),
  ('mj12bot', 'Majestic', 'seo'),
  ('dotbot', 'Moz', 'seo'),
  ('webtelemetrybot', 'Webtelemetry', 'audit'),
  ('chrome-lighthouse', 'Google', 'audit'),
  ('headlesschrome', 'headless Chrome', 'audit');

create function public.is_crawler(user_agent text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(user_agent, '') <> '' and exists (
    select from public.crawler_agents c where strpos(lower(user_agent), c.token) > 0
  )
$$;

-- PostgREST hands each request's headers to the transaction as JSON.
create function public.request_is_crawler()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_crawler(nullif(current_setting('request.headers', true), '')::json ->> 'user-agent')
$$;

-- Restrictive: on top of each table's own "users can …" policy, never instead.
create policy "crawlers send no impressions" on public.link_impressions
  as restrictive for insert to anon, authenticated with check (not public.request_is_crawler());
create policy "crawlers send no visits" on public.link_visits
  as restrictive for insert to anon, authenticated with check (not public.request_is_crawler());
create policy "crawlers cast no votes" on public.votes
  as restrictive for insert to anon, authenticated with check (not public.request_is_crawler());

-- Owner-executed (it reads auth.users and auth.sessions, which service_role
-- can't), so it is revoked from every client role.
create view public.crawler_accounts
as
select u.id as user_id, first_session.user_agent, first_session.created_at as first_seen_at
from auth.users u
cross join lateral (
  select s.user_agent, s.created_at from auth.sessions s
  where s.user_id = u.id
  order by s.created_at
  limit 1
) first_session
where u.is_anonymous and public.is_crawler(first_session.user_agent);

revoke all on public.crawler_accounts from anon, authenticated;
grant select on public.crawler_accounts to service_role;
