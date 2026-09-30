-- links_to_enrich: the newest links an automatic step hasn't processed yet,
-- over the whole table (not just a recent window). 'topics' also skips links
-- that already have any topic label, hand or Jev; 'entities' only looks at
-- link_enrichment. Called by topic-label and entity-extract as service_role.
create function public.links_to_enrich(step text, max_results integer)
returns table (link_id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  select l.id
  from links l
  left join link_enrichment e on e.link_id = l.id
  where case step
    when 'topics' then e.topics_at is null
      and not exists (select 1 from link_topics lt where lt.link_id = l.id)
    when 'entities' then e.entities_at is null
    else false
  end
  order by l.created_at desc, l.id desc
  limit max_results
$$;

revoke execute on function public.links_to_enrich(text, integer) from public, anon, authenticated;

-- entity-extract: every 5 minutes, up to 30 links a run, one at a time (so
-- a new entity is matchable by the next link). A run takes a minute or two,
-- so runs don't overlap; with nothing to process it makes no Jev calls.
select cron.schedule(
  'entity-extract',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public.app_setting('functions_url') || '/entity-extract',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.app_setting('anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
