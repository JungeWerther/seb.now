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
--                             (service_role only)
--   account_columns.disposable  the columns whose rows may go with a crawler's
--                             account: nothing a reader made by hand
--   purge_crawler_accounts()  deletes the crawler accounts holding nothing but
--                             disposable rows; run by hand, never on a schedule
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

alter table public.account_columns add column disposable boolean not null default false;
comment on column public.account_columns.disposable is
  'Rows in this column are signals or bookkeeping, not anything a reader made: purge_crawler_accounts may delete them with the account.';
update public.account_columns set disposable = true
where (tbl, col) in (
  ('public.profiles'::regclass, 'id'::name),
  ('public.link_impressions'::regclass, 'viewer_id'::name),
  ('public.link_visits'::regclass, 'visitor_id'::name),
  ('public.query_credits'::regclass, 'user_id'::name)
);

-- Whether a user has a row in one account column.
create function public.account_holds(target public.account_columns, account uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  held boolean;
begin
  execute format('select exists (select from %s where %I = $1)', target.tbl, target.col) into held using account;
  return held;
end;
$$;

-- The crawler accounts holding nothing but disposable rows.
create view public.purgeable_crawler_accounts
as
select c.user_id, c.user_agent, c.first_seen_at
from public.crawler_accounts c
where not exists (
  select from public.account_columns ac
  where not ac.disposable and public.account_holds(ac, c.user_id)
);

revoke all on public.purgeable_crawler_accounts from anon, authenticated;
grant select on public.purgeable_crawler_accounts to service_role;

-- Deletes them (their profile, impressions, visits and credits cascade) and
-- says how many. Refuses while account_columns misses a user column, since
-- then "holds nothing else" can't be told. The candidates' user and profile
-- rows are locked first, which waits out any insert still referencing them
-- (its foreign-key check holds a key-share lock) and blocks new ones; the
-- delete's own statement then rechecks them on a fresh snapshot, so a vote
-- committed meanwhile keeps its account.
create function public.purge_crawler_accounts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  purged integer;
begin
  perform public.refuse(
    exists (select from public.account_columns_missing),
    'account_columns is missing a column that references a user');
  perform from auth.users u
  where u.id in (select p.user_id from public.purgeable_crawler_accounts p)
  order by u.id
  for update;
  perform from public.profiles pr
  where pr.id in (select p.user_id from public.purgeable_crawler_accounts p)
  order by pr.id
  for update;
  with gone as (
    delete from auth.users u
    using public.purgeable_crawler_accounts p
    where u.id = p.user_id
    returning u.id
  )
  select count(*) into purged from gone;
  return purged;
end;
$$;

revoke execute on function public.account_holds(public.account_columns, uuid) from public, anon, authenticated;
revoke execute on function public.purge_crawler_accounts() from public, anon, authenticated;
grant execute on function public.purge_crawler_accounts() to service_role;
