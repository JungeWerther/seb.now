-- Sources as entities. A source — a followed row in public.sources, or a handle
-- a link names as its author (@Channel5YouTube) — is an entity under a new
-- entity.source branch of the kind tree, one subkind per source type, and every
-- link it published is tagged with it in link_entities (found_in = labeled_by =
-- 'source'). So the existing pages cover sources with no new routes:
-- /k/entity.source lists every source, /k/entity.source.youtube_channel every
-- channel, /e/<id> one source's posts, and "youtube channel" is a kind the
-- search box tags and filters by.
--
-- Additive only: new kinds, columns, functions and rows; two check constraints
-- are widened (a new value allowed), nothing is dropped or rewritten.

-- 1. The kind branch. Subkind paths are public.sources.kind values.
insert into public.kinds (path, label, description) values
  ('entity.source', 'Source', 'A channel, account, feed or calendar that publishes posts'),
  ('entity.source.youtube_channel', 'YouTube channel', null),
  ('entity.source.mastodon_account', 'Mastodon account', null),
  ('entity.source.web_feed', 'Web feed', 'A site''s RSS or Atom feed'),
  ('entity.source.ical_feed', 'Calendar', 'A public event calendar (iCalendar)')
on conflict (path) do nothing;

-- The legacy flat kind gets 'source' (shown on a post's page); kind_path holds
-- the subkind.
alter table public.entities drop constraint entities_kind_check;
alter table public.entities add constraint entities_kind_check check (kind = any (array[
  'company', 'cooperative', 'nonprofit', 'public_body', 'person', 'product',
  'place', 'event', 'work', 'other', 'source'
]));

create or replace function public.kind_to_path(k text) returns ltree
language sql immutable set search_path = public, extensions as $$
  select case k
    when 'person'      then 'entity.agent.person'
    when 'company'     then 'entity.agent.org.company'
    when 'nonprofit'   then 'entity.agent.org.nonprofit'
    when 'public_body' then 'entity.agent.org.public_body'
    when 'cooperative' then 'entity.agent.org'
    when 'product'     then 'entity.artifact.product'
    when 'work'        then 'entity.artifact.work'
    when 'place'       then 'entity.place'
    when 'event'       then 'entity.event'
    when 'source'      then 'entity.source'
    else 'entity'
  end::ltree
$$;

-- 2. Where a source's entity and handle live, and which source a link came from.
alter table public.sources
  add column entity_id uuid references public.entities(id) on delete set null,
  add column handle text check (handle ~ '^@[^[:space:]]{1,99}$');
create unique index sources_kind_handle_key on public.sources (kind, lower(handle));
create index sources_entity_id_idx on public.sources (entity_id);

-- Set by the ingest functions; null for links from elsewhere (HN, by hand).
alter table public.links
  add column source_id uuid references public.sources(id) on delete set null;
create index links_source_id_idx on public.links (source_id);

-- 3. A source tag is its own kind of mention.
alter table public.link_entities drop constraint link_entities_found_in_check;
alter table public.link_entities add constraint link_entities_found_in_check
  check (found_in = any (array['title', 'page', 'source']));
alter table public.link_entities drop constraint link_entities_labeled_by_check;
alter table public.link_entities add constraint link_entities_labeled_by_check
  check (labeled_by = any (array['manual', 'jev', 'source']));

-- 4. Naming. A label reads "Name: what it covers"; Luma calendars read
-- "Luma: Name", the platform first.
create function public.source_name(label text, identifier text) returns text
language sql immutable set search_path = public as $$
  select left(coalesce(
    nullif(btrim(case when label ~* '^luma: ' then substr(label, 7) else split_part(label, ': ', 1) end), ''),
    identifier
  ), 200)
$$;

create function public.source_description(label text) returns text
language sql immutable set search_path = public as $$
  select case when label !~* '^luma: ' and position(': ' in label) > 0
    then nullif(btrim(substr(label, position(': ' in label) + 2)), '') end
$$;

-- A URL's host without www./feed(s)./rss., so a feed and its site's posts meet.
create function public.source_host(url text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(substring(lower(url) from '^[a-z][a-z0-9+.-]*://([^/:?#@]+)'), '^(www|feeds?|rss)\.', '')
$$;

-- 5. Find or create a source entity by (name, kind), the entities' unique key.
create function public.source_entity_upsert(entity_name text, entity_kind ltree, entity_description text)
returns uuid
language plpgsql set search_path = public, extensions as $$
declare
  found uuid;
begin
  select id into found from entities where lower(name) = lower(entity_name) and kind_path = entity_kind;
  if found is null then
    insert into entities (name, kind, kind_path, description)
    values (entity_name, 'source', entity_kind, entity_description)
    on conflict (lower(name), kind_path) do nothing
    returning id into found;
    if found is null then
      select id into found from entities where lower(name) = lower(entity_name) and kind_path = entity_kind;
    end if;
  end if;
  return found;
end $$;

-- A handle-only entity ("@johnnyharris", made before the channel's handle was
-- known) folds into its source's entity: its tags move over, then it goes.
create function public.fold_handle_entity(handle text, source_kind text, into_entity uuid)
returns void
language plpgsql set search_path = public, extensions as $$
declare
  stray uuid;
begin
  select e.id into stray from entities e
  where lower(e.name) = lower(handle) and e.kind_path = ('entity.source.' || source_kind)::ltree
    and e.id <> into_entity
    and not exists (select 1 from sources s where s.entity_id = e.id);
  if stray is null then return; end if;
  insert into link_entities (link_id, entity_id, surface, p, labeled_by, found_in)
  select link_id, into_entity, surface, p, labeled_by, found_in from link_entities where entity_id = stray
  on conflict (link_id, entity_id) do nothing;
  delete from entities where id = stray;
end $$;

create function public.ensure_source_entity(source uuid) returns uuid
language plpgsql set search_path = public, extensions as $$
declare
  s sources;
  eid uuid;
begin
  select * into s from sources where id = source;
  if s.id is null then return null; end if;
  eid := s.entity_id;
  if eid is null then
    eid := source_entity_upsert(source_name(s.label, s.identifier), ('entity.source.' || s.kind)::ltree, source_description(s.label));
    update sources set entity_id = eid where id = s.id;
  end if;
  if s.handle is not null then
    perform fold_handle_entity(s.handle, s.kind, eid);
  end if;
  return eid;
end $$;

-- 6. Which source a link came from, most certain first: the source the ingest
-- recorded; the Mastodon account in its post URI; a source with its author's
-- handle; the web feeds on its host, when they all name the same outlet. A
-- YouTube or fediverse author no followed source claims becomes a source of
-- its own, named by the handle.
-- The source kind a link's @author handle belongs to: YouTube for a video
-- (whichever ingest found it), Mastodon for a fediverse post; else none.
create function public.link_handle_kind(l links) returns text
language sql stable set search_path = public, extensions as $$
  select case
    when youtube_video_id(l.url) is not null then 'youtube_channel'
    when l.origin = 'fediverse' then 'mastodon_account'
  end
$$;

create function public.link_source(l links) returns uuid
language plpgsql stable set search_path = public, extensions as $$
declare
  found uuid;
  acct text;
begin
  if l.source_id is not null then return l.source_id; end if;
  acct := substring(l.fediverse_post_uri from '^https://[^/]+/users/([^/]+)/') || '@'
       || substring(l.fediverse_post_uri from '^https://([^/]+)/users/');
  if acct is not null then
    select id into found from sources where kind = 'mastodon_account' and lower(identifier) = lower(acct);
    if found is not null then return found; end if;
  end if;
  -- Handles are unique per kind only, so match within the link's platform.
  if l.author is not null and link_handle_kind(l) is not null then
    select id into found from sources
    where kind = link_handle_kind(l) and lower(handle) = lower(l.author);
    if found is not null then return found; end if;
  end if;
  select min(id::text)::uuid into found from sources
  where kind = 'web_feed' and source_host(identifier) = source_host(l.url)
  having count(distinct lower(source_name(label, identifier))) = 1;
  return found;
end $$;

create function public.tag_link_source(link uuid) returns void
language plpgsql set search_path = public, extensions as $$
declare
  l links;
  s sources;
  source uuid;
  eid uuid;
  handle_kind ltree;
begin
  select * into l from links where id = link;
  if l.id is null then return; end if;
  source := link_source(l);
  if source is not null then
    select * into s from sources where id = source;
    -- The ingest knows the channel and YouTube's oEmbed told us the video's
    -- handle. Only for YouTube: a Mastodon account's post can link someone
    -- else's video, whose author isn't the account.
    if s.handle is null and l.source_id = s.id and s.kind = 'youtube_channel'
       and youtube_video_id(l.url) is not null
       and l.author ~ '^@[^[:space:]]{1,99}$'
       and not exists (select 1 from sources o where o.kind = s.kind and lower(o.handle) = lower(l.author)) then
      update sources set handle = l.author where id = s.id;
    end if;
    eid := ensure_source_entity(s.id);
  elsif l.author ~ '^@[^[:space:]]{1,99}$' and link_handle_kind(l) is not null then
    handle_kind := ('entity.source.' || link_handle_kind(l))::ltree;
    eid := source_entity_upsert(l.author, handle_kind, null);
  end if;
  -- Drop a tag that no longer holds (another source, or none: a host became
  -- ambiguous). Only when there is one: any delete bumps index_state.gen.
  if exists (select 1 from link_entities
             where link_id = l.id and found_in = 'source' and entity_id is distinct from eid) then
    delete from link_entities where link_id = l.id and found_in = 'source' and entity_id is distinct from eid;
  end if;
  if eid is null then return; end if;
  insert into link_entities (link_id, entity_id, surface, p, labeled_by, found_in)
  values (l.id, eid, left(coalesce(l.author, s.label, (select name from entities where id = eid)), 200), 1, 'source', 'source')
  on conflict (link_id, entity_id) do nothing;
end $$;

-- Every link a source may have published, re-tagged (a new feed, a handle learnt).
create function public.retag_source_links(source uuid) returns void
language plpgsql set search_path = public, extensions as $$
declare
  s sources;
begin
  select * into s from sources where id = source;
  if s.id is null then return; end if;
  perform tag_link_source(l.id) from links l
  where l.source_id = s.id
     or (s.handle is not null and lower(l.author) = lower(s.handle))
     or (s.kind = 'mastodon_account' and l.fediverse_post_uri ilike
          'https://' || split_part(s.identifier, '@', 2) || '/users/' || split_part(s.identifier, '@', 1) || '/%')
     or (s.kind = 'web_feed' and source_host(l.url) = source_host(s.identifier));
end $$;

-- None of these are for clients: they write, and only run from the triggers
-- below or by hand.
revoke execute on function public.source_entity_upsert(text, ltree, text) from public, anon, authenticated;
revoke execute on function public.fold_handle_entity(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.ensure_source_entity(uuid) from public, anon, authenticated;
revoke execute on function public.link_source(links) from public, anon, authenticated;
revoke execute on function public.link_handle_kind(links) from public, anon, authenticated;
revoke execute on function public.tag_link_source(uuid) from public, anon, authenticated;
revoke execute on function public.retag_source_links(uuid) from public, anon, authenticated;

-- 7. Kept current by triggers.
create function public.links_tag_source() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  perform tag_link_source(new.id);
  return null;
end $$;

create trigger links_tag_source
  after insert or update of source_id, author, url, fediverse_post_uri on public.links
  for each row execute function public.links_tag_source();

create function public.sources_sync_entity() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  perform ensure_source_entity(new.id);
  perform retag_source_links(new.id);
  return null;
end $$;

-- pg_trigger_depth guards the update ensure_source_entity itself makes.
create trigger sources_sync_entity
  after insert or update of identifier, handle on public.sources
  for each row when (pg_trigger_depth() < 1) execute function public.sources_sync_entity();

-- 8. Title and page extraction never resolve a mention into a source: a
-- channel named "Belfast Telegraph" isn't the newspaper a headline names.
create or replace function public.entity_candidates(phrase text, max_results integer default 8)
returns table(id uuid, name text, kind text, description text, example_title text, similarity real)
language sql stable set search_path = public, extensions as $$
  with scored as (
    select e.id, greatest(
      similarity(lower(e.name), lower(phrase)),
      coalesce((select max(similarity(lower(m.surface), lower(phrase)))
                from link_entities m where m.entity_id = e.id and m.surface is not null), 0)
    ) as similarity
    from entities e
    where e.kind <> 'source'
  )
  select e.id, e.name, e.kind, e.description,
    (select l.title from link_entities m join links l on l.id = m.link_id
     where m.entity_id = e.id order by m.created_at limit 1),
    s.similarity
  from scored s join entities e on e.id = s.id
  where s.similarity >= 0.3
  order by s.similarity desc, e.created_at
  limit max_results
$$;

create or replace function public.known_names(first_words text[], max_results integer default 3000)
returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(name), '{}')
  from (
    select e.name
    from public.entities e
    where public.name_first_word(e.name) = any(first_words)
      and length(e.name) >= 3
      and e.kind <> 'source'
    limit max_results
  ) t
$$;

-- 9. The focused view's related rows carry found_in like FEED_SELECT now does,
-- so the page keeps a link's source off its entity chips there too.
create or replace function public.related_feed(link uuid, max_results integer default 10, page_offset integer default 0)
returns table(link_id uuid, score double precision, shared_entities text[], shared_topics text[], link_row jsonb)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select r.link_id, r.score, r.shared_entities, r.shared_topics,
    jsonb_build_object(
      'id', l.id,
      'title', l.title,
      'url', l.url,
      'image_url', l.image_url,
      'author', l.author,
      'created_at', l.created_at,
      'link_topics', coalesce((
        select jsonb_agg(jsonb_build_object('p', lt.p, 'topics', jsonb_build_object('id', t.id, 'name', t.name)))
        from link_topics lt
        join topics t on t.id = lt.topic_id
        where lt.link_id = l.id
      ), '[]'::jsonb),
      'link_entities', coalesce((
        select jsonb_agg(jsonb_build_object('p', le.p, 'found_in', le.found_in,
          'entities', jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind)))
        from link_entities le
        join entities e on e.id = le.entity_id
        where le.link_id = l.id
      ), '[]'::jsonb)
    )
  from related_links(link, max_results, page_offset) with ordinality as r(link_id, score, shared_entities, shared_topics, n)
  join links l on l.id = r.link_id
  order by r.n
$$;

-- 10. Backfill: an entity per followed source, then every link's tag.
select public.ensure_source_entity(id) from public.sources order by created_at;
select public.tag_link_source(id) from public.links
where author is not null or fediverse_post_uri is not null
   or source_host(url) in (select source_host(identifier) from public.sources where kind = 'web_feed');
