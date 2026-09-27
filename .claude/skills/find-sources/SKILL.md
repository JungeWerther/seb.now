---
name: find-sources
description: Find the original outlets (a personal blog, a newsletter, a Mastodon account) of people and publications the user wants to read first-hand, discover and verify their RSS/Atom feed, and follow them by adding them to public.sources so their new posts land in the seb.now feed. Use when the user names a writer, thinker or site to follow (e.g. "geohot's blog"), wants primary sources instead of coverage, or asks to grow the feed's non-YouTube sources.
---

# find-sources

Goal: follow people at the source, not through whoever writes about them.
Each followed outlet becomes a `public.sources` row in project
`yoxrhqlzsqwfjmsjpari`; all database steps use `mcp__Supabase__execute_sql`.

| Outlet | `kind` | `identifier` | Read by |
|---|---|---|---|
| Blog, newsletter, any site with RSS/Atom | `web_feed` | the feed URL (`https://` only) | `web-feed-ingest` (`0 3-23/6 * * *`) |
| Mastodon account | `mastodon_account` | `handle@instance` | `fediverse-ingest` |
| YouTube channel | use the `explore-taste` skill | | |

## 1. Work out who

If the user named people or sites, start there. Otherwise, read what's
already followed and liked, then ask (`AskUserQuestion`, one round) whose
thinking they want first-hand: which fields, and whether they prefer long
essays, short notes or technical write-ups.

```sql
select kind, identifier, label, enabled from public.sources order by kind, label;
```

For a person, name their *own* outlet: geohot → his blog
(`geohot.github.io/blog`), not articles about him. Use `WebSearch` to find it
when unsure. Many writers have several (a blog, a Substack, Mastodon);
suggest the one they post substantive writing to, and mention the others.

## 2. Discover the feed

The sandbox can't reach arbitrary sites, but the database can, through
`pg_net`. Fetch the homepage:

```sql
select net.http_get('<homepage url>') as req;
```

and read the feed it advertises. `rel`/`type`/`href` come in any order, so
match the whole `<link>` tag first:

```sql
select id, status_code,
  (select array_agg(t[1]) from regexp_matches(content,
     '(<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*>)', 'gi') t) as feed_links
from net._http_response where id = <req>;
```

Take the `href` of the `rel="alternate"` one and resolve it against the page.
If there's none, try the usual paths: `/feed`, `/feed.xml`, `/rss.xml`,
`/atom.xml`, `/index.xml`, and for Substack `https://<name>.substack.com/feed`.

## 3. Verify it

Never follow a feed you haven't fetched and checked. The ingest takes the
first 10 posts of whatever is at that URL.

```sql
select net.http_get('<feed url>') as req;

select id, status_code,
  (select count(*) from regexp_matches(content, '<entry[\s>]', 'g')) as atom_entries,
  (select count(*) from regexp_matches(content, '<item[\s>]', 'g')) as rss_items,
  substring(content from '<title[^>]*>([^<]*)</title>') as feed_title,
  (regexp_match(content, '<(?:published|updated|pubDate)>([^<]+)</(?:published|updated|pubDate)>'))[1] as latest
from net._http_response where id = <req>;
```

It needs status 200, at least one entry or item, a title that's the outlet you
meant, and a recent enough latest date that it's still alive (say why if you
follow a dormant one anyway). The identifier must be `https://`; if a site
only serves `http`, it can't be followed.

For Mastodon, verify the account through the instance's public API:
`https://<instance>/api/v1/accounts/lookup?acct=<handle>` should return the
account, and its `statuses_count` and `last_status_at` should show it's active.

```sql
select net.http_get('https://<instance>/api/v1/accounts/lookup?acct=<handle>') as req;

select status_code, content::jsonb->>'acct' as acct,
  content::jsonb->>'statuses_count' as statuses, content::jsonb->>'last_status_at' as last_status_at
from net._http_response where id = <req>;
```

## 4. Confirm, then follow

Show the verified outlets (name, feed URL, latest post date and title) and let
the user pick with an `AskUserQuestion` multiSelect. Adding a source changes
the public feed for everyone.

```sql
insert into public.sources (kind, identifier, label)
values ('web_feed', '<feed url>', '<Name: what they write about>')
on conflict (kind, identifier) do update set enabled = true;
```

## 5. Pull the posts in now

Run the matching cron job's own command, so the bearer key never shows up in
the conversation (`web-feed-ingest`, or `fediverse-ingest` for Mastodon):

```sql
do $$ begin execute (select command from cron.job where jobname = 'web-feed-ingest'); end $$;
```

After a few seconds, read the reply. It's the newest JSON response: status
200, `errors` empty, `upserted` > 0.

```sql
select status_code, left(content, 600) from net._http_response
where content like '{%"upserted"%' order by created desc limit 1;
```

Then confirm the posts are in `links`:

```sql
select title, url, created_at from public.links
where url like '<site origin>%' order by created_at desc limit 10;
```

Each post's `created_at` is its publication date, so a dormant blog's posts
rank as old and won't flood the top of the feed. Posts arrive untagged, at a
neutral taste of 0.5.

## 6. Report

List what was followed (name, feed URL, latest post), what was skipped and
why, and how many posts came in.
