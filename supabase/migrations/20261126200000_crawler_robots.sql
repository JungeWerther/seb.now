-- robots.txt: which crawlers seb.now asks to stay away.
--
--   crawler_agents.robots_disallow   true for a crawler robots.txt sends away
--                                    (Disallow: /); every other reader, crawler
--                                    or not, is welcome under `User-agent: *`
--
-- The build reads the column and writes dist/robots.txt from it, so changing
-- who is turned away is an update here, not a code change. Google's and
-- OpenAI's crawlers are turned away, search included; their audit tools
-- (chrome-lighthouse) don't read robots.txt and keep the default.
--
-- Additive only: a new column with a default, one new crawler row, and flags
-- set on existing rows. No row is deleted.

alter table public.crawler_agents
  add column robots_disallow boolean not null default false;

comment on column public.crawler_agents.robots_disallow is
  'Whether robots.txt disallows this crawler the whole site.';

-- Google's Vertex AI crawler, which only obeys its own token.
insert into public.crawler_agents (token, operator, purpose) values
  ('google-cloudvertexbot', 'Google', 'ai')
on conflict (token) do nothing;

update public.crawler_agents
  set robots_disallow = true
  where operator in ('Google', 'OpenAI') and purpose in ('search', 'ai');
