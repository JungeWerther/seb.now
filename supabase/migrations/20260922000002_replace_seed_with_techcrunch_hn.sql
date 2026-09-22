-- Replaces the placeholder Fed-rate-cut/election dummy seed data with real
-- TechCrunch and Hacker News links. Mainstream media is deliberately
-- skipped for this pass (per owner request) - neither techcrunch.com nor
-- news.ycombinator.com is in MAINSTREAM_MEDIA_DOMAINS, so both classify as
-- DIRECT_LINK already, no source_type.py changes needed.
delete from links;

insert into links (submitted_by, url, title, origin) values
  (null, 'https://techcrunch.com/2026/09/01/air-raises-50m-to-help-companies-vet-the-skills-and-add-ons-ai-agents-use/', 'AIR raises $50M to help companies vet the skills and add-ons AI agents use', 'local'),
  (null, 'https://techcrunch.com/2026/09/02/hiddenlayer-nabs-100m-as-enterprises-rush-to-secure-their-ai-deployments/', 'HiddenLayer nabs $100M as enterprises rush to secure their AI deployments', 'local'),
  (null, 'https://techcrunch.com/2026/08/26/viral-ai-startup-instinct-has-raised-350-million-at-a-2-5-billion-valuation/', 'Viral AI startup Instinct has raised $350M at a $2.5B valuation', 'local'),
  (null, 'https://techcrunch.com/2026/08/11/general-catalyst-leads-1-1b-round-into-2-month-old-river-ai/', 'General Catalyst leads $1.1B round into 2-month-old River AI', 'local'),
  (null, 'https://techcrunch.com/2026/08/06/naive-raises-28-5m-to-automate-the-grunt-work-of-setting-up-and-running-a-company/', 'Naïve raises $28.5M to automate the grunt work of setting up and running a company', 'local'),
  (null, 'https://news.ycombinator.com/item?id=47835735', 'Kimi K2.6: Advancing open-source coding', 'local'),
  (null, 'https://news.ycombinator.com/item?id=48511908', 'Open source AI must win', 'local'),
  (null, 'https://news.ycombinator.com/item?id=47780712', 'Open Source Isn''t Dead', 'local'),
  (null, 'https://news.ycombinator.com/item?id=49156111', 'Devtools must be open source', 'local'),
  (null, 'https://news.ycombinator.com/item?id=47945918', 'Soft launch of open-source code platform for government', 'local');
