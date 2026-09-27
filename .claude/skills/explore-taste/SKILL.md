---
name: explore-taste
description: Interview the user about the videos and styles they like, find YouTube channels that match, and follow the ones they pick by adding them to public.sources so their recent uploads show up in the seb.now feed. Use when the user wants to explore their taste, discover new creators or channels, or grow the feed's YouTube sources.
---

# explore-taste

Goal: turn a short conversation about taste into a few new `youtube_channel`
rows in `public.sources` (project `yoxrhqlzsqwfjmsjpari`), which
`youtube-ingest` then pulls into `links`. Every step that touches the database
uses `mcp__Supabase__execute_sql` on that project.

## 1. Start from what's already known

Before asking anything, read:

```sql
select identifier, label, enabled from public.sources
where kind = 'youtube_channel' order by label;
```

and the YouTube links people liked most, with their topics:

```sql
select l.title, l.author, v.score,
       (select array_agg(lt.topic_id::text) from public.link_topics lt where lt.link_id = l.id) as topics
from public.links l
join (select link_id, sum(value) as score from public.votes group by link_id) v on v.link_id = l.id
where public.youtube_video_id(l.url) is not null
order by v.score desc limit 20;
```

If the user gives their seb.now handle, narrow that to their own votes
(`where voter_id = (select id from public.profiles where handle = '<handle>')`
in the votes subquery)
and add their downvotes as things to avoid. Use all of this to make the
questions specific ("you follow Channel 5: more street interviews, or more
long-form docs?") instead of generic.

## 2. Ask, briefly

Use `AskUserQuestion`: one round of up to four questions, a second round only
if the answers leave the direction unclear. Cover:

- **Format**: long-form documentary, street/vox-pop interviews, video essays,
  sketch/comedy, music/performance, explainers, vlogs.
- **Tone**: deadpan/absurd, earnest/investigative, chaotic, calm/slow.
- **Subjects**: pull options from the topics above and from `public.topics`.
- **Anchors**: a channel or video they love that isn't followed yet (they
  answer with "Other"). One anchor beats any number of adjectives.

Treat anything the user says they like as a signal, even outside the
questions.

## 3. Propose candidates

Find 5–8 channels that fit, using `WebSearch` ("channels like <anchor>",
"<format> youtube channel <subject>") plus your own knowledge. Skip channels
already in `sources` (enabled or not). Prefer channels that still upload
regularly and post mainly long-form videos: `youtube-ingest` skips Shorts, so a
Shorts-only channel adds nothing.

Show them with one line each on why they match, then let the user pick with an
`AskUserQuestion` multiSelect (split into several questions if there are more
than four). Only follow what they pick: adding a source changes the public
feed for everyone.

## 4. Resolve and verify each channel id

The sandbox can't reach youtube.com, but the database can, through `pg_net`.
Never insert an id you haven't verified this way; a mistyped or remembered id
passes the format check and silently ingests the wrong channel, or nothing.

Fetch each picked channel's handle page:

```sql
select net.http_get('https://www.youtube.com/@<handle>') as req;
```

then, after a few seconds, read the id and name from the response:

```sql
select id, status_code,
  substring(content from '<link rel="canonical" href="https://www.youtube.com/channel/(UC[A-Za-z0-9_-]{22})"') as channel_id,
  substring(content from '<title>([^<]*)</title>') as title
from net._http_response where id in (<req ids>);
```

Then fetch each id's Atom feed, which is exactly what the ingest reads, and
check it: status 200, the feed `<title>` is the channel you meant, and it has
recent entries that aren't all Shorts (`shorts` counts `/shorts/` links, one
per Short, so `entries - shorts` is what the ingest will actually take):

```sql
select net.http_get('https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>') as req;

select id, status_code,
  substring(content from '<title>([^<]*)</title>') as title,
  (select count(*) from regexp_matches(content, '<entry>', 'g')) as entries,
  (select count(*) from regexp_matches(content, '/shorts/', 'g')) as shorts,
  substring(substring(content from position('<entry>' in content)) from '<published>([^<]*)</published>') as latest_upload,
  (select array_agg(m[1]) from regexp_matches(content, '<yt:videoId>([^<]+)</yt:videoId>', 'g') m) as video_ids
from net._http_response where id in (<req ids>);
```

Drop any channel that fails a check, and say why.

## 5. Follow

```sql
insert into public.sources (kind, identifier, label)
values ('youtube_channel', '<UC…>', '<Channel name: what it is>')
on conflict (kind, identifier) do update set enabled = true;
```

The label follows the existing ones: the channel name, plus a few words on what
it is when the name doesn't say.

## 6. Pull their uploads in now

Don't wait for the next `45 */6 * * *` run. Run the cron job's own command, so
the bearer key never shows up in the conversation:

```sql
do $$ begin execute (select command from cron.job where jobname = 'youtube-ingest'); end $$;
```

After about a minute, check that it worked. The newest `net._http_response`
row (`order by created desc`) should be the ingest's reply: status 200, with
an empty `errors` list in its JSON body. The new channels' videos should now
be in `links`:

```sql
select count(*) from public.links
where public.youtube_video_id(url) in (<video_ids from step 4>);
```

The page loads its ranked feed client-side, so the new videos show on seb.now
without a redeploy. They arrive untagged, so they rank with a neutral taste of
0.5 until topics are labelled.

## 7. Report

List what was followed (name, id, and why it matched), what was dropped and
why, and how many videos came in.
