// Local QA of the source-entities migration, on a schema shaped like
// production (the tables, constraints and triggers it touches) with seeded
// sources and links: the backfill, then the triggers as ingests would fire them.
import { PGlite } from "@electric-sql/pglite";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";

const [migration] = process.argv.slice(2);
const db = new PGlite({ extensions: { ltree, pg_trgm } });

await db.exec(`
create extension ltree;
create extension pg_trgm;
create schema extensions;
create role anon; create role authenticated;
create table public.kinds (
  path ltree primary key check (subpath(path, 0, 1) = 'entity'),
  label text not null, description text,
  parent ltree generated always as (case when nlevel(path) > 1 then subpath(path, 0, nlevel(path) - 1) end) stored references public.kinds(path)
);
insert into kinds (path, label) values ('entity','Entity'),('entity.agent','Agent'),('entity.agent.org','Organization'),
  ('entity.agent.org.company','Company'),('entity.place','Place');
create table public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  kind_path ltree references kinds(path),
  description text,
  created_at timestamptz not null default now(),
  constraint entities_kind_check check (kind in ('company','cooperative','nonprofit','public_body','person','product','place','event','work','other'))
);
create unique index entities_name_kind_key on entities (lower(name), kind_path);
create function kind_to_path(k text) returns ltree language sql immutable as $$
  select case k when 'company' then 'entity.agent.org.company' when 'place' then 'entity.place' else 'entity' end::ltree $$;
create function entities_sync_kind_path() returns trigger language plpgsql as $$
begin
  if new.kind_path is null then new.kind_path := kind_to_path(new.kind); end if;
  return new;
end $$;
create trigger entities_sync_kind_path before insert or update of kind, kind_path on entities
  for each row execute function entities_sync_kind_path();
create function name_first_word(name text) returns text language sql immutable as $$ select lower(split_part(name, ' ', 1)) $$;
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('youtube_channel','mastodon_account','web_feed','ical_feed')),
  identifier text not null, label text, enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, identifier)
);
create table public.links (
  id uuid primary key default gen_random_uuid(),
  url text not null unique, title text not null default 't',
  origin text not null default 'feed', author text, fediverse_post_uri text unique, image_url text,
  created_at timestamptz not null default now()
);
create function youtube_video_id(url text) returns text language sql immutable as $$
  select substring(url from 'youtube\\.com/watch\\?v=([A-Za-z0-9_-]{11})') $$;
create table public.link_entities (
  link_id uuid references links(id) on delete cascade,
  entity_id uuid references entities(id) on delete cascade,
  surface text, p real not null default 1,
  labeled_by text not null default 'manual', found_in text not null default 'title',
  created_at timestamptz not null default now(),
  primary key (link_id, entity_id),
  constraint link_entities_found_in_check check (found_in in ('title','page')),
  constraint link_entities_labeled_by_check check (labeled_by in ('manual','jev'))
);
create table public.topics (id text primary key, name text);
create table public.link_topics (link_id uuid, topic_id text, p real);
create function related_links(link uuid, max_results integer, page_offset integer)
  returns table(link_id uuid, score double precision, shared_entities text[], shared_topics text[])
  language sql as $$ select null::uuid, null::float8, null::text[], null::text[] where false $$;
create function entity_candidates(phrase text, max_results integer default 8)
  returns table(id uuid, name text, kind text, description text, example_title text, similarity real)
  language sql as $$ select null::uuid, null, null, null, null, null::real where false $$;
create function known_names(first_words text[], max_results integer default 3000) returns text[]
  language sql as $$ select '{}'::text[] $$;
`);

// Seeds, as production has them before the migration.
await db.exec(`
insert into entities (name, kind) values ('Belfast Telegraph', 'company');
insert into sources (kind, identifier, label) values
  ('youtube_channel', 'UC-AQKm7HUNMmxjdS371MSwg', 'Channel 5 with Andrew Callaghan'),
  ('youtube_channel', 'UC8DDYNnDrXYKSsVJ58rUumw', 'Belfast Telegraph'),
  ('mastodon_account', 'colossal@mastodon.art', 'Colossal: contemporary art and visual culture'),
  ('web_feed', 'https://simonwillison.net/atom/everything/', 'Simon Willison: LLMs and developer tools, short notes'),
  ('web_feed', 'https://feeds.kottke.org/main', 'kottke.org: Jason Kottke on art, culture and science'),
  ('web_feed', 'https://cen.acs.org/feeds/rss/business.xml', 'C&EN Business: business news'),
  ('web_feed', 'https://cen.acs.org/feeds/rss/latest.xml', 'C&EN Latest: all news'),
  ('web_feed', 'https://www.taxipro.nl/tag/nlcabs/feed', 'TaxiPro: NLCabs tag'),
  ('web_feed', 'https://www.taxipro.nl/apps/feed', 'TaxiPro: apps en tooling'),
  ('ical_feed', 'https://api.lu.ma/ics/get?entity=calendar&id=cal-3OpKEgfnjQ1Ps6z', 'Luma: The Offline Club Paris');
insert into links (url, author, origin, fediverse_post_uri) values
  ('https://www.youtube.com/watch?v=aaaaaaaaaaa', '@Channel5YouTube', 'feed', null),
  ('https://www.youtube.com/watch?v=bbbbbbbbbbb', '@Channel5YouTube', 'feed', null),
  ('https://www.youtube.com/watch?v=ccccccccccc', '@johnnyharris', 'feed', null),
  ('https://simonwillison.net/2026/Oct/1/x/', null, 'feed', null),
  ('https://kottke.org/26/10/y', null, 'feed', null),
  ('https://cen.acs.org/business/z.html', null, 'feed', null),
  ('https://www.taxipro.nl/nieuws/q', null, 'feed', null),
  ('https://www.thisiscolossal.com/2026/10/art/', null, 'fediverse', 'https://mastodon.art/users/colossal/statuses/1'),
  ('https://news.ycombinator.com/item?id=1', null, 'feed', null),
  ('https://lu.ma/event1', null, 'feed', null);
`);

await db.exec(readFileSync(migration, "utf8"));

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const tagOf = async (url) =>
  (await rows(
    `select e.name, e.kind_path::text kind from link_entities le join entities e on e.id = le.entity_id
     join links l on l.id = le.link_id where l.url = $1 and le.found_in = 'source'`, [url]))
    .map((r) => `${r.name} (${r.kind})`);

// Backfill.
check("every followed source has an entity",
  (await rows(`select count(*)::int n from sources where entity_id is null`))[0].n, 0);
check("names and subkinds",
  (await rows(`select e.name, e.kind, e.kind_path::text kind_path, e.description from sources s join entities e on e.id = s.entity_id
     where s.identifier in ('colossal@mastodon.art', 'https://api.lu.ma/ics/get?entity=calendar&id=cal-3OpKEgfnjQ1Ps6z') order by e.name`)),
  [{ name: "Colossal", kind: "source", kind_path: "entity.source.mastodon_account", description: "contemporary art and visual culture" },
   { name: "The Offline Club Paris", kind: "source", kind_path: "entity.source.ical_feed", description: null }]);
check("a source is another sense than the company of the same name",
  (await rows(`select kind_path::text k from entities where name = 'Belfast Telegraph' order by 1`)).map((r) => r.k),
  ["entity.agent.org.company", "entity.source.youtube_channel"]);
check("two feeds of one outlet share an entity",
  (await rows(`select count(distinct entity_id)::int n from sources where label like 'TaxiPro%'`))[0].n, 1);
check("web feed post tagged by host", await tagOf("https://simonwillison.net/2026/Oct/1/x/"), ["Simon Willison (entity.source.web_feed)"]);
check("feeds./www. stripped", await tagOf("https://kottke.org/26/10/y"), ["kottke.org (entity.source.web_feed)"]);
check("one host, two outlets: no guess", await tagOf("https://cen.acs.org/business/z.html"), []);
check("one host, one outlet", await tagOf("https://www.taxipro.nl/nieuws/q"), ["TaxiPro (entity.source.web_feed)"]);
check("mastodon post tagged by its URI", await tagOf("https://www.thisiscolossal.com/2026/10/art/"), ["Colossal (entity.source.mastodon_account)"]);
check("unfollowed YouTube handle is a source of its own", await tagOf("https://www.youtube.com/watch?v=ccccccccccc"), ["@johnnyharris (entity.source.youtube_channel)"]);
check("HN link untagged", await tagOf("https://news.ycombinator.com/item?id=1"), []);
check("followed channel's handle unknown yet: handle entity",
  await tagOf("https://www.youtube.com/watch?v=aaaaaaaaaaa"), ["@Channel5YouTube (entity.source.youtube_channel)"]);

// youtube-ingest re-upserts a video with its source_id: the handle is learnt
// and the handle entity folds into the channel's.
await db.exec(`update links set source_id = (select id from sources where identifier = 'UC-AQKm7HUNMmxjdS371MSwg')
  where url = 'https://www.youtube.com/watch?v=aaaaaaaaaaa'`);
check("handle learnt", (await rows(`select handle from sources where identifier = 'UC-AQKm7HUNMmxjdS371MSwg'`))[0].handle, "@Channel5YouTube");
check("ingested video tagged with the channel", await tagOf("https://www.youtube.com/watch?v=aaaaaaaaaaa"),
  ["Channel 5 with Andrew Callaghan (entity.source.youtube_channel)"]);
check("its other video moved over too", await tagOf("https://www.youtube.com/watch?v=bbbbbbbbbbb"),
  ["Channel 5 with Andrew Callaghan (entity.source.youtube_channel)"]);
check("handle entity gone", (await rows(`select count(*)::int n from entities where name = '@Channel5YouTube'`))[0].n, 0);

// A new video arrives through HN with that author: matched by handle.
await db.exec(`insert into links (url, author) values ('https://www.youtube.com/watch?v=ddddddddddd', '@channel5youtube')`);
check("later link matched by handle", await tagOf("https://www.youtube.com/watch?v=ddddddddddd"),
  ["Channel 5 with Andrew Callaghan (entity.source.youtube_channel)"]);

// The ical ingest records its calendar.
await db.exec(`update links set source_id = (select id from sources where kind = 'ical_feed') where url = 'https://lu.ma/event1'`);
check("ical event tagged", await tagOf("https://lu.ma/event1"), ["The Offline Club Paris (entity.source.ical_feed)"]);

// Following a new feed tags its site's existing posts.
await db.exec(`insert into links (url) values ('https://pluralistic.net/2026/10/01/a/');
  insert into sources (kind, identifier, label) values ('web_feed', 'https://pluralistic.net/feed/', 'Pluralistic: Cory Doctorow on tech policy')`);
check("new feed tags old posts", await tagOf("https://pluralistic.net/2026/10/01/a/"), ["Pluralistic (entity.source.web_feed)"]);

// Setting a handle by hand folds the handle entity.
await db.exec(`insert into sources (kind, identifier, label) values ('youtube_channel', 'UCmGSJVG3mCRXVOP4yZrU1Dw', 'Johnny Harris: geopolitics explainers');
  update sources set handle = '@johnnyharris' where identifier = 'UCmGSJVG3mCRXVOP4yZrU1Dw'`);
check("hand-set handle folds", await tagOf("https://www.youtube.com/watch?v=ccccccccccc"), ["Johnny Harris (entity.source.youtube_channel)"]);

// Re-running an ingest (same upsert) changes nothing.
const before = (await rows(`select count(*)::int n from link_entities`))[0].n;
await db.exec(`update links set author = author, source_id = source_id`);
check("idempotent", (await rows(`select count(*)::int n from link_entities`))[0].n, before);

// Copilot review cases.
// A handle is matched within the link's platform only.
await db.exec(`insert into sources (kind, identifier, label, handle) values ('mastodon_account', 'example@mastodon.social', 'Example on Mastodon', '@example');
  insert into links (url, author) values ('https://www.youtube.com/watch?v=eeeeeeeeeee', '@example')`);
check("same handle on another platform not matched", await tagOf("https://www.youtube.com/watch?v=eeeeeeeeeee"),
  ["@example (entity.source.youtube_channel)"]);
// A Mastodon account sharing someone's video doesn't learn that video's handle.
await db.exec(`insert into links (url, author, origin, fediverse_post_uri, source_id) values
  ('https://www.youtube.com/watch?v=fffffffffff', '@someoneelse', 'fediverse', 'https://mastodon.art/users/colossal/statuses/2',
   (select id from sources where identifier = 'colossal@mastodon.art'))`);
check("mastodon account keeps no handle", (await rows(`select handle from sources where identifier = 'colossal@mastodon.art'`))[0].handle, null);
// A host turning ambiguous clears the old tag.
await db.exec(`insert into sources (kind, identifier, label) values ('web_feed', 'https://simonwillison.net/other.xml', 'Someone Else: other outlet')`);
check("ambiguous host clears stale tag", await tagOf("https://simonwillison.net/2026/Oct/1/x/"), []);
// An unchanged re-upsert deletes nothing (would bump the index gen).
await db.exec(`create table deletes (n int); insert into deletes values (0);
  create function count_deletes() returns trigger language plpgsql as $f$ begin update deletes set n = n + 1; return null; end $f$;
  create trigger count_deletes after delete on link_entities for each statement execute function count_deletes();
  update links set author = author`);
check("no-op re-upsert runs no delete", (await rows(`select n from deletes`))[0].n, 0);

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
