# seb.now — project instructions

## What this is

`seb.now` — a news website. Currently scaffolded as a bare `uv`-managed
Python package (`src/seb_now`); no web framework has been chosen yet.

## Infrastructure: Supabase + DigitalOcean

**Storage — Supabase.** Project `seb-now`, ref `yoxrhqlzsqwfjmsjpari`, URL
`https://yoxrhqlzsqwfjmsjpari.supabase.co`. This is a dedicated project, so a
public-facing site's anon key never shares a database with private data.
Access it with the `mcp__Supabase__*` tools using that project ref; there is
no CLI/local Supabase link in this repo.

Schema: `profiles` / `links` / `votes` / `follows`, RLS enabled on all four
(policies scoped to `auth.uid()`), migrations versioned under
`supabase/migrations/`. `profiles` rows are auto-created by an
`auth.users` insert trigger. **Anonymous Sign-ins must be enabled in the
Supabase dashboard** (Authentication → Sign In / Providers) — no MCP tool
exposes that toggle, and votes/follows depend on it (RLS write access
without requiring a real signup).

The anon/publishable key is safe to expose (RLS is what protects the
data, not secrecy of that key) but is deliberately **not committed** to
this repo — `.env` is git-ignored here. It's kept in two places instead:
a local, untracked `.env` (`SUPABASE_URL` + `SUPABASE_ANON_KEY`) for local
dev/test, and GitHub Actions repository **variables** (not secrets, since
it isn't one) of the same names, which `.github/workflows/ci.yml` reads
for the integration test (falling back to a secret of the same name when
no variable is set). The static site itself (browser client, and
`site.py`'s build-time read) never uses `service_role` — every user
write goes through RLS as an authenticated (including anonymous) user.
The one exception is `service_role` inside the three ingestion Edge
Functions (see below) — server-side only, never shipped to a client.

**Ingestion — four Edge Functions, each on its own `pg_cron` schedule,
all inside the `seb-now` project itself**:

**Followed sources live in `public.sources`, not in code** — one row per
followed account/channel (`kind`: `youtube_channel` or `mastodon_account`,
`identifier`, `label`, `enabled`), public-read, service_role-write. Following
or dropping a source is a row insert/update (`enabled = false` to pause), with
no redeploy. A check constraint validates `identifier` per kind (a
`UC…` channel id; `handle@instance` for Mastodon), because the ingest
functions build fetch URLs from it and a Mastodon instance becomes the request
host. TechCrunch and Hacker News aren't rows: each is a single fixed API, and
the function *is* the source.

- `fediverse-ingest` (`0 */6 * * *`) — pulls recent public posts from the
  enabled `mastodon_account` rows in `sources` (currently
  `@DAIR@dair-community.social` for AI ethics/policy and
  `@colossal@mastodon.art` for contemporary art/visual culture — swapped
  in for `@blendernation@mastodon.online`, which turned out to read as
  3D-software tutorial news rather than art) via each instance's public
  REST API (no auth needed for public statuses — simpler and more
  stable than parsing raw ActivityPub outboxes, and every account on
  the list happens to be Mastodon). Upserts into `links` as
  `origin: 'fediverse'`, `onConflict: 'fediverse_post_uri'`,
  `POSTS_PER_ACCOUNT = 10`.
- `hn-ingest` (`15 */6 * * *`) — Hacker News's public Firebase API
  (`topstories.json` + `item/{id}.json`, no auth), top 25 stories.
- `techcrunch-ingest` (`30 */6 * * *`) — TechCrunch's public RSS feed
  (`techcrunch.com/feed/`), top 20 items, extracted with a small regex
  (not a full XML parser — the feed's `<item>`/`<title>`/`<link>` shape
  is stable and simple enough that a parser dependency isn't worth it).
- `youtube-ingest` (`45 */6 * * *`) — each channel's public Atom feed
  (`youtube.com/feeds/videos.xml?channel_id=…`, no auth, latest 15 uploads)
  for the enabled `youtube_channel` rows in `sources` (currently Channel 5
  with Andrew Callaghan and no cap on god).
  Shorts (`/shorts/` links) are skipped. Videos upsert as `origin: 'feed'`
  with a canonical `watch?v=` url, `image_url` set to the video's
  `hqdefault.jpg` (letterboxed 4:3, which the 16:9 cover crop trims exactly),
  and `created_at` set to the upload date rather than ingest time, so a
  channel's backlog doesn't all rank as fresh. Each run then fills
  `links.author` with the uploading channel's `@handle` (from YouTube's oEmbed,
  which answers data-centre requests) for up to `AUTHOR_SWEEP_LIMIT` YouTube
  links still without one, whichever ingest added them. Deployed with
  `verify_jwt` on; its cron sends the same anon-key bearer as the others.

**Blog posts** are how "your own submission" (the `origin: 'local'`
value that's existed in the schema since the start) actually gets
authored — as rows in `links` itself, not as files in this repo. Two
extra nullable columns exist for exactly this: `slug` (unique when set;
builds the post's static page path) and `body_markdown` (the full post
body). Publishing means inserting a `links` row directly (via the
Supabase MCP tools, bypassing RLS — there's no public write endpoint or
user-facing form, matching every other write path here) with `origin:
'local'`, a `slug`, `title`, `description`, optional `image_url`, and
`body_markdown` set, then triggering a DO redeploy so the static build
picks it up (neither a DB-only change nor a push to `main` triggers a
rebuild — every DO deployment is started manually).

`site.py` (`src/seb_now/posts.py`) queries `links` at build time for
every `origin: 'local'` row with a non-null `slug`/`body_markdown` and
renders each to a standalone static page — `dist/posts/<slug>/index.html`
— with its own `og:title`/`og:description`/`og:image` tags (so if a post
is ever itself shared into the fediverse, `fediverse-ingest`'s own
preview-image scraping picks it up the same way it would any other
site). The same row is also just a normal feed entry via `load_feed()`,
so a post is voteable, greyable-on-visit, and thumbnail-eligible with no
separate sync step. Markdown-to-HTML uses the `markdown` package
(`extra` + `sane_lists` extensions) rather than a hand-rolled parser,
unlike the ingest functions' regex extractors — correctly handling
nested lists, code fences, etc. isn't "simple regex-shaped" the way
RSS's flat `<item>`/`<title>`/`<link>` tags are.

An earlier version of this synced `posts/*.md` files from this repo via
a fourth edge function, `local-post-ingest`, on a `*/15 * * * *`
schedule — reverted because the content itself doesn't belong in the
repo. That function is still deployed (no MCP tool exposes deleting an
Edge Function) but its cron job has been unscheduled, so it's inert;
safe to ignore, or delete by hand from the Supabase dashboard.

`fediverse-ingest` also populates `links.image_url`: Mastodon's own
`status.card.image` when a card exists, else `fediverse-ingest` peeks at
the target page itself (5s timeout) for `og:image`, falling back to the
page's first `<img>`. `techcrunch-ingest` fetches each article page (5s
timeout) for its `og:image`, since the RSS feed carries no images; a failed
fetch leaves `image_url` out of the upsert so an earlier cover is kept.
`hn-ingest` does the same for each story's linked page (not Ask HN threads),
but since those are arbitrary sites it only takes a declared preview —
`og:image`, else `twitter:image` — never a first-`<img>` guess, so pages
without one stay imageless. YouTube doesn't serve `og:image` to those
data-centre fetches, so a `links` trigger (`links_fill_youtube_thumbnail`,
via `public.youtube_video_id(url)`) fills any YouTube video link saved
without an image with its `hqdefault.jpg` thumbnail, whichever ingest wrote
it. Because covers are hotlinked from third-party
sites, the page script removes any `.cover-link` whose image fails to load. Each article row has a
left favicon column (`FAVICON_URL_TEMPLATE`, DuckDuckGo's icon service,
falling back to the host's first letter); the domain, title row and — when
`image_url` is set — a clickable 16:9 cover image share the indented
column to its right, cover below the title. The domain line also carries
`links.author` when set (`domain_with_author` in `site.py`, `domainWithAuthor`
in the page script): a handle stands in for the domain (`@Channel5YouTube`;
the favicon still shows the platform), a display name follows it
(`youtube · Name`).
After it comes the post's date, `links.created_at` (`posted_label` in
`site.py`, `postedLabel` in the page script: "Sep 27", plus the year when it
isn't this year's, in UTC), in a `<time class="posted">` that stays in the
flex row even when empty, since it's what pushes the topic chips right.
`created_at` is the original publication date for YouTube, `web_feed` and
TechCrunch links (its RSS `pubDate`); for the other ingests it's when the link
was first ingested.

Both upsert into `links` as `origin: 'feed'`, `onConflict: 'url'` (falling
back to the HN item's own discussion-page URL when a story has no
external `url`, e.g. Ask HN). `links.url` and `links.fediverse_post_uri`
both have plain (non-partial) unique indexes for this — note PostgREST's
`upsert(onConflict:)` can't resolve against a *partial* unique index
(Postgres won't infer the conflict target through an unstated `WHERE`),
which is why these are full indexes rather than e.g.
`... where fediverse_post_uri is not null` — harmless here since `NULL`
never collides with `NULL` under uniqueness anyway.

The four schedules are staggered 15 minutes apart (`:00`/`:15`/`:30`/`:45`)
so they don't all hit the DB/edge runtime at once.

`origin` has three values: `local` (a user's own submission — none yet;
no UI for it exists), `fediverse`, and `feed` (HN/TechCrunch). The
original TechCrunch/HN seed rows were hand-picked once via web search
before `hn-ingest`/`techcrunch-ingest` existed and were tagged `local`
for lack of a better bucket at the time; they've since been reclassified
to `feed` (same category, just picked by hand) rather than deleted,
since three of them already carried real votes and a delete+reingest
would have orphaned that history for no reason (their URLs simply
weren't in HN's/TechCrunch's *current* top lists at seed time, so a
plain re-run wouldn't have touched them).

**Topics — the recommender's label space.** `public.topics` is a fixed,
human-named taxonomy keyed by an `ltree` path (`ai.agents`,
`sports.football`), so `'ai' @> topic_id` selects a parent and all its
children without a recursive query. `description` is the definition a
classifier reads for each label. Links are tagged with leaf topics only,
in `public.link_topics` as fuzzy `p ∈ (0, 1]`, typically 1–3 per link;
`labeled_by` is `manual` (hand labels) or `jev` (the TypeSafe Jev
decision model, see below). Both tables are public-read, service_role-write.

**Automatic topic labels — `topic-label`.** An Edge Function labels every link
that has no `link_topics` rows yet (so hand labels are never touched), up to 60
per run, on its own `pg_cron` job (`55 */3 * * *`; URL and anon key read from
`app_settings`' `functions_url`/`anon_key` at run time). It walks the topic
tree top-down with Jev (`jev-1.13.0`, pinned; key from Vault as
`typesafe-ai-token` via `get_vault_secret`): each node is one Choice over its
children, with the topics' `name: description` as the options (the root adds
a "none of these"), and the 3 best paths are kept (beam search) by the
geometric mean of their edge probabilities, so a shallow and a deep leaf
compare fairly. The distinct leaves of the final beam scoring ≥ 0.5 become
`labeled_by = 'jev'` rows with `p` = that score. The state is only the
link's title, host and (when set) description. `POST {"link_ids": [...],
"dry_run": true}` returns labels without writing, for evaluation: on 60
hand-labelled links the top Jev label matched a hand label (same topic, or
one an ancestor of the other) for 46, any Jev label for 49, and the top-level
area for 52, at ~1,600 input tokens and 2 requests per link.
`functions/_shared/jev.ts` is a small typed System One client. To undo:
`delete from link_topics where labeled_by = 'jev'`.

The `economy` branch is not hand-made: it is the full JEL classification
(Journal of Economic Literature, AEA — 1,015 codes), with JEL's own hierarchy as
the path (L41 → `economy.L.L4.L41`, three-digit codes are the leaves; a
"General"/"Other" heading is named after its parent so its chip reads alone).
`topics.jel_code` holds each JEL topic's code, and for hand-made topics outside
the branch the nearest JEL code (`business.cooperatives` → J54,
`politics.competition_antitrust` → K21), so economics coverage maps onto one
standard ontology. Tag an economics story with the JEL leaf, not also with a
hand-made topic mapped to the same code (that would count the vote twice).

What an article is *about* is a topic; *who* it is about is an entity.
`public.entities` (organisations: `kind` company/cooperative/nonprofit/public_body,
`country` ISO 3166-1, `wikidata_id`) carries each one's `nace_code` from
`public.nace_activities`, the full NACE Rev. 2.1 tree (EU activity
classification, 1,047 codes, `parent_code` links class → group → division →
section). NACE 2.1 separates platforms from the service they broker: a
ride-hailing app (NLCabs, Uber, a driver co-op) is 52.32 *intermediation for
passenger transportation*, a taxi operator 49.33. `public.link_entities` links
articles to the entities they cover. All three are public-read,
service_role-write; only look up a `wikidata_id` (never recall one), and leave
`nace_code` null rather than guess.

Entities aren't only organisations: `kind` also allows person, product, place,
event, work and other (`nace_code` stays for organisations). The
**`entity-extract`** Edge Function fills them from titles, on its own `pg_cron`
job (`*/5 * * * *`, up to 30 links a run, which takes a minute or two, so runs
don't overlap and links stay one at a time): `candidates.ts` proposes phrases (compromise's noun chunks,
whole and split at connecting words and possessives, plus capitalised runs, their
two-word windows and camel-case words; pronouns, leading number words and
phrases with a possessive inside dropped); one Jev request
per link asks of each whether it's a name, a concept or neither, and its kind;
names with p ≥ 0.8 are matched against existing entities by
`public.entity_candidates(phrase)` (trigram similarity on names and past
mention texts) — an exact name is taken, otherwise Jev picks one of the
candidates or "none", and none creates the entity. Links run one at a time so
a new entity is matchable by the next link. Jev's mentions land in
`link_entities` with `surface` (the text as written, which doubles as an
alias), `p` and `labeled_by = 'jev'`; hand rows default to `manual`, p 1.
`public.link_enrichment (link_id, topics_at, entities_at)` records when each
automatic step last ran on a link (service_role only), so `topic-label` and
`entity-extract` don't retry links that yielded nothing; both pick their next
links with `public.links_to_enrich(step, max_results)` (newest first over the
whole table; execute revoked from clients). Both functions share
`functions/_shared/jev.ts`.

A user's preference is derived, not stored: the
`public.user_topic_preferences` view (`security_invoker`, so RLS on
`votes`/`link_topics` applies) gives per `(voter_id, topic_id)` the
`likes`/`dislikes` sums of `p` over their up/downvoted links and
`alpha = 1 + likes`, `beta = 1 + dislikes`. Each vote also counts toward
every ancestor of the labelled topic (`ai.agents` feeds `ai`), so a
never-voted leaf can fall back to its parent. No time decay yet. Not
built yet: the client Thompson-sampling `θ ~ Beta(alpha, beta)` per
topic and ranking links by `Σ θ·p`.
`site.py` embeds each link's `link_topics` in the build-time feed query
and renders the top `ARTICLE_TOPIC_CHIPS` (by `p`) leaf-topic names as
chips side by side, right-aligned on the domain line (vertically centred
with it and the favicon); untagged links show none.

**Feed pagination, ranking and search.** The build pre-renders only the newest
`FEED_PAGE_SIZE` links (constants.py, injected into the page script along
with `ARTICLE_TOPIC_CHIPS`/`FAVICON_URL_TEMPLATE`) for a fast first paint; the
page script then replaces them with the **ranked feed** once its first page
arrives, and fetches further pages as you scroll (infinite scroll via an
`IntersectionObserver` on `#feed-sentinel`, no page numbers). Ranking is the
`public.ranked_feed(as_of, page_offset, page_size)` SQL function (security
invoker, so `auth.uid()` is the viewer):
`rank = taste * (1 + ups) / (2 + ups + downs) * 0.5 ^ (age_hours / 24)`
(age capped at 1000 days, since 0.5 raised to a years-old YouTube upload's age
underflows a double and Postgres errors rather than rounding to 0) —
`taste` is the viewer's p-weighted mean topic score over the link's topics (their
`topic_overrides` score if they set one, else the `user_topic_preferences` one) (a never-voted topic falls back to its parent, then 0.5;
untagged links are 0.5), `ups`/`downs` are everyone's votes on the link, and
freshness halves every 24h. It returns `(link_id, rank)` pages; the client
then loads those links by id with `FEED_SELECT` and sorts them into rank order.
Pages are offset-based against an `as_of` fixed when the feed starts, so ages
don't shift between pages; votes can still move a link between pages, so the
client skips ids it has already shown. If `ranked_feed` fails, the pre-rendered
links stay and the feed carries on newest-first. It ranks every link on each
call — fine at hundreds of links, needs a precomputed score or a recency cut-off
before tens of thousands. The My Algorithm overlay spells this formula out in
plain words in a code block; keep the two in sync.

Search is server-side and newest-first: a debounced `ilike` on
`links.search_text`, a stored generated column (lowercased title + host
without `www.`) with a `pg_trgm` GIN index, keyset-paged on
`(created_at desc, id desc)` — `id` breaks ties because one ingest upsert
stamps all its rows with the same `now()`. Client-fetched articles are built by
cloning `<template id="article-template">`, which `site.py` renders with the
same `_render_article` as the pre-rendered ones, so there's one copy of the
markup (filled via `textContent`/attributes, never `innerHTML`). Per-article
vote, visit and reply queries run per page, so their `.in("link_id", ...)`
lists stay page-sized. Supabase Realtime isn't involved — it pushes row
changes, it doesn't query.

**XSS defences (`src/seb_now/sanitize.py`).** Every string from the DB is
untrusted, even `links` rows (only `service_role` writes them, but ingest
copies URLs and titles from arbitrary sites). Layers, all of which must hold:
text goes through `html.escape` server-side and `textContent` client-side;
`href`/`src` URLs must be `http(s)` (`safe_http_url` at build time, which
drops a link whose url isn't; `isHttpUrl` in the page script); blog-post
markdown is sanitized with `nh3` after rendering; values injected into the
inline script go through `script_json` (escapes `<`/`>`/`&`, so a value can't
close the `<script>`); post slugs must match `POST_SLUG_PATTERN` since they
become file paths. The backstop is a `<meta>` Content-Security-Policy:
`index.html` allows only its own inline module script, by a SHA-256 hash that
`site.py` computes over the final rendered script, plus the pinned
`SUPABASE_JS_MODULE_URL` origin; post pages allow no script at all. So
inline event handlers (`onerror=` etc.) can't be used in markup — image
error handling is one capture-phase listener in the page script — and bumping
supabase-js means changing `SUPABASE_JS_MODULE_URL`, not the template.

**Header menu.** The header's left icon (Lucide `circle-user-round`) opens a
dropdown of round "bubbles" (`#menu-bubbles`), one per menu item. Each bubble
names a `<dialog class="overlay">` (`data-overlay`) opened with `showModal()`
— floating over the feed, closed by its ✕, a backdrop click or Escape — with
an optional loader in `OVERLAY_LOADERS`. **My Algorithm** (`#taste-overlay`)
lists the signed-in user's leaf topics from `user_topic_preferences`, ranked
by the Beta mean `alpha / (alpha + beta)`, with the view's `upvotes`/`downvotes`
counts, the score itself (the formula's output, two decimals) and a
green/red slider whose split is the score. The slider is hand-rolled on
pointer events (`role="slider"`, arrow/Page/Home/End keys), not `<input
type="range">`, which Firefox for Android kept snapping back mid-drag; it's
`touch-action: pan-y`, and like swiping a card a touch only takes the slider
once it has moved `SWIPE_CAPTURE_SLOP_PX` mostly sideways (a mostly-vertical
one is the list scrolling and never moves the thumb); once taken it follows
the pointer wherever it goes until release (a mouse takes it at once, a tap
sets the value). The user's own score for a topic goes to
`public.topic_overrides` (private to its owner by RLS), which `ranked_feed`
uses in place of the vote-derived score; a custom topic gets an ✕ that drops
just its override, and "Reset all to default" drops them all. The UI updates
at once and writes go behind it: changes queue per topic and are sent in one
batch after `TASTE_SAVE_DELAY_MS` of stillness, or immediately when the
overlay closes (then the feed re-ranks) or the page is hidden; reopening the
overlay flushes the queue before reading back. Above the list a code block shows the feed's ranking formula (see "Feed
pagination, ranking and search"), so keep it in sync with `ranked_feed`.
**My Profile** (`#profile-overlay`) edits `profiles.handle`, the name shown on
replies and the reader's fediverse username (`@handle@seb.now`, previewed live
under the field); the page lowercases it and checks the same pattern as the
DB before saving.

**Wordmark.** The header's SVG wordmark has its `viewBox` trimmed to the
glyphs; its ink (`--brand-ink-height`, lifted by `--brand-ink-offset`) is
centred in the header with `--header-brand-gap` above and below it, and the
menu icon is centred vertically. There's no tagline.

**Replies.** `public.replies` (`link_id`, `author_id` → `profiles`,
`body`, `created_at`): publicly readable; any signed-in user (anonymous
sessions included, same as votes) can insert/delete only their own
(`auth.uid() = author_id`), and there's no update policy. The DB checks
bound the body to 1–500 non-blank chars (the page's `REPLY_MAX_LENGTH`
mirrors this) and reject control characters except newline/tab. Bodies
are stored exactly as typed — **XSS safety comes from output encoding,
not input stripping**: the client only ever puts reply text (and
handles) into the DOM via `textContent`, and anything server-rendered
must go through `html.escape`. `tests/test_site.py` fails if the page
script assigns `innerHTML`/`outerHTML` from anything but a string
literal, or uses `insertAdjacentHTML`/`document.write`. Each post has a
round reply button (below the post box, right-aligned, outside `.post-swipe` so it stays put while the card is swiped) that swaps the search
bar for a reply composer in the same dock; replies are loaded
client-side and listed under the post. No moderation or rate limiting
yet — anyone with an anonymous session can post.

**A link's own page.** Every link has a page at `seb.now/p/<id>` (the same
address a federated post links to, served by the catch-all document): a
`<dialog id="link-overlay">` over the feed showing the link, all its entities
(with their kind) and topics as chips, and its related links. Each article's
round tag button (`.details-btn`, left of the reply button) opens it with
`history.pushState`, storing how many pages deep it is (`linkPageDepth`), so
Back steps between pages, Forward returns, and closing (✕, backdrop, Escape)
jumps straight back to the feed; visiting the address directly opens it at
depth 0 and closing replaces the address with `/`. Related links come from
`public.related_links(link, max_results)` (security invoker): shared entities
count double, shared leaf topics once, each weighted p × p, newest first on
ties; it returns the shared names, shown under each related link ("Shares
OpenAI, AI industry"), and each related link has its own tag button to go a
level deeper. Its lists use `.link-list`, not `.articles`: the feed is found
with `querySelector("ul.articles")`.

Swipe-to-vote is scoped to the post box only: `.post-swipe` wraps the
vote tints (`.swipe-bg`) and the `.post` that slides over them, so the
favicon, domain/chips line and replies don't react. While dragged, the
post swings like a card hanging from a pivot `SWIPE_PIVOT_DISTANCE_PX`
below it, confined to an arc-shaped band: horizontal finger travel alone
sets the angle around that pivot (clamped to `SWIPE_MAX_ANGLE_DEG`) and
vertical travel alone sets the radius (clamped to the pivot distance ±
`SWIPE_RADIAL_SLACK_PX`); the card tilts by that angle. Don't derive the
angle from the finger's position relative to the pivot (`atan2(dx, R -
dy)`): a steep downward drag then amplifies a small dx into a large tilt,
can cross the vote threshold, and flips past the pivot. A drag must start
sideways (`touch-action: pan-y`, so vertical-first gestures scroll) and
not heading upward. Once the finger has moved `SWIPE_CAPTURE_SLOP_PX`,
a gesture that is vertical-dominant or climbs steeper than
`SWIPE_START_MAX_UP_DEG` is a feed scroll and the card never moves; a
sideways one picks the card up immediately (no delay — a visible lag
between thumb and card reads as unresponsive). If within
`SWIPE_START_DECIDE_MS` of crossing the slop it turns to head upward after
all, the card springs back and the gesture becomes a scroll. A
sideways-leaning scroll gets no native scrolling under `pan-y`, so the page
scrolls itself with the finger and flings on release
(`SCROLL_FLING_DECAY_MS`); vertical-dominant ones are left to the browser. From
the moment a sideways gesture crosses the slop it is *claimed*: `touchmove` is `preventDefault`ed and `html.swiping` sets
`overscroll-behavior: none`, so neither scrolling nor pull-to-refresh can
take it over however far down the finger goes. Pointer events
only update the finger's target position; a single rAF loop eases the
drawn card toward it (exponential follow, `SWIPE_SMOOTHING_MS` time
constant, frame-rate independent) so uneven event delivery can't make it
jitter. Vote decisions use the finger's target, not the eased position.
Below the vote threshold the tint only previews (up to
`SWIPE_TINT_PREVIEW_OPACITY`, icon and label dimmed); the moment the
finger's target crosses it the tint gets `.armed` — full opacity, the icon
pops, one light sheen sweeps diagonally upward across it (from the bottom-left corner for an upvote, the bottom-right for a downvote), and a short
`navigator.vibrate` where supported — and loses it again if dragged back,
so "release now counts" is unambiguous. `--post-bg` must stay
opaque for the same reason (a translucent post would show the tint
through it). The handler only takes pointer capture once the pointer has
moved `SWIPE_CAPTURE_SLOP_PX`, and never starts on a `<button>` —
capturing on `pointerdown` retargets a plain tap's `click` to the swipe
area, so links and buttons inside would never receive it.

supabase-js is loaded with a dynamic `import()` (`supabaseReady`), not a
static import, so the page script — swipe handlers included — runs before
the library has downloaded; every client call awaits `supabaseReady`.
Swipe handlers are attached before the anonymous session and the
own-vote/score/visited queries resolve; `castVote`/`removeVote` take the
pending session promise and send once it resolves.

**MCP server — agents read the feed.** The `mcp` Edge Function
(`supabase/functions/mcp/index.ts`) is a remote MCP server at
`https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/mcp`, hand-rolled like
`activitypub`: Streamable HTTP, stateless (each POST is one JSON-RPC message
answered with plain JSON; GET/DELETE are 405, no SSE, no sessions). Read-only
tools: `get_feed` (`ranked_feed` as a logged-out visitor, so taste is a neutral
0.5), `search_links` (same `search_text` ilike as the page), `list_topics`,
`get_links_by_topic` (a topic id and all its children), `get_link` (with vote
counts and replies). It queries with the **anon key**, never `service_role`, so
RLS limits it to exactly what a logged-out visitor sees. It's deployed with
`verify_jwt` **off**, since MCP clients don't send a Supabase JWT — safe
because `/mcp` only reads, and `/mcp/user` checks its own token (below).

**Signed-in MCP (`/mcp/user`) — OAuth via Supabase Auth.** The same function
answers `…/functions/v1/mcp/user` (served at `https://seb.now/mcp/user` by the
DO proxy `mcp/user`, which unlike `mcp/server` forwards `Authorization` and
relays `WWW-Authenticate`). It needs a bearer token from the project's OAuth
2.1 server (enabled in the dashboard under Authentication → OAuth Server, with
dynamic client registration on and Authorization Path `/oauth/consent`),
checks it with `auth.getUser` (so a revoked grant stops working at once), and
queries as that user: `get_feed` is ranked by their taste, and it adds a `vote`
tool (up/down/clear). Without a valid token it answers 401 with
`WWW-Authenticate: Bearer resource_metadata=…` pointing at the RFC 9728
metadata the function serves at `…/functions/v1/mcp/oauth-protected-resource`
(resource `https://seb.now/mcp/user`, authorization server
`…supabase.co/auth/v1`) — that 401 is what makes an MCP client start the OAuth
flow, which is why this is a separate endpoint rather than optional auth on
`/mcp`. Supabase sends the user to `seb.now/oauth/consent`
(`src/seb_now/consent.py` + `templates/consent.html`, built into
`dist/oauth/consent/index.html`), which approves or denies with
`supabase.auth.oauth.*` as the browser's own session — the same, usually
anonymous, account as the feed — and only follows an http(s) return address.
Reply and `topic_overrides` tools aren't built yet. It's also served at
`https://seb.now/mcp` through the DO Functions proxy `mcp/server`
(`functions/packages/mcp/server`), with its own exact-match ingress rule
(`/mcp` → `rewrite: /mcp/server`), the same pattern as `/ap/inbox`. The proxy
sends an empty body (202 notification replies) as `text/plain`, since DO's
gateway rejects a JSON content type on a non-JSON body.
The repo's `.mcp.json` registers it as the `seb-now` server, so Claude Code
sessions in this repo get its tools.

**Open privacy question (deferred until there are real users):**
`votes` is publicly readable (the page shows net scores), so any user's
topic profile is derivable by anyone from `votes` ⋈ `link_topics`.
Either accept that as part of an "open algorithm" stance, or make
per-voter rows private and expose only per-link totals via a view.

**Hosting — DigitalOcean.** The site is meant to ship as a static
site (no server framework — see the architecture discussion for why:
Supabase's auto-generated REST API + `supabase-js` + RLS covers reads,
votes, and follows straight from the browser). DO's env should hold
*only* `SUPABASE_ANON_KEY`/`SUPABASE_URL` — no `service_role`, matching
the Supabase secrets policy above. **No DigitalOcean MCP/CLI is
connected in this environment** — there is currently no automated way to
inspect or deploy to DO from a Claude Code session here; DO setup is a
manual step until that changes.

**ActivityPub proxy — real actor, not a stub.** `fediverse-ingest` above
only ever *reads* from the fediverse (Mastodon's public REST API).
Becoming a followable ActivityPub actor at `@seb@seb.now` needs the
opposite direction too — but WebFinger resolution for that handle requires
`GET https://seb.now/.well-known/webfinger` to be answered by something at
that exact host, which a static site can't do on its own. `functions/` is
a DigitalOcean Functions project (a `functions`-type App Platform
component, free under DO's per-team 90,000 GiB-second/month allowance)
added to the app spec to give `seb.now` real endpoints at that host:
`/.well-known/webfinger` and `/ap/inbox` (plus `/mcp` and `/mcp/user`, see above). Each
function is a thin proxy forwarding to the `activitypub` Supabase Edge
Function and relaying the response back unchanged, keeping the actual
protocol logic in one runtime. `/ap/actor` is **not** proxied: its ingress
rule is a `redirect` (308, `authority: yoxrhqlzsqwfjmsjpari.supabase.co`,
`uri: /functions/v1/activitypub/ap/actor`), so the actor document comes
straight from Supabase — see "DO Functions can't serve the actor" below.

That Supabase function implements the real protocol, hand-rolled (not
Fedify): a single site-wide `Person` actor (not per-profile — the local
`profiles`/`follows` tables model something else, a profile following
someone; this models the world following the site), with a real RSA
keypair for HTTP Signatures, a `public.ap_followers` table, and signed
`Accept` replies to `Follow` activities. What's built:

- **WebFinger** (`/.well-known/webfinger?resource=acct:seb@seb.now`) —
  returns a real JRD pointing at the actor.
- **Actor document** (`/ap/actor`) — a `Person` with `publicKey` (fetched
  from Vault at request time, not embedded in source).
- **Inbox** (`POST /ap/inbox`) — verifies the sender's HTTP Signature in
  either scheme: RFC 9421 HTTP Message Signatures (`Signature-Input`,
  `Signature: sig1=:…:`, `Content-Digest` — what mastodon.social sends) or
  draft-cavage (RSA-SHA256 over `(request-target) host date digest`),
  fetching the sender's own actor doc for their public key with a signed
  GET (servers in Mastodon's secure mode 401 an unsigned one), then:
  `Follow` → upserts into `ap_followers` and delivers a signed `Accept`
  back to the follower's inbox; `Undo` of a `Follow` → deletes the
  follower row. A `Like` or `Announce` of one of our posts → an upvote on
  its link from a `public.remote_actors` row (the sender, with its
  `@user@host` handle); `Undo` of either removes that vote (so undoing one
  of a like+boost removes both's upvote). A public `Create(Note)` whose
  `inReplyTo` is one of our posts → a `replies` row (HTML content reduced
  to plain text, `ap_object_id` = the note's id); a `Delete` of it removes
  the reply. Followers-only/direct replies are ignored, since replies are
  public. Anything else is accepted (202) and logged.
- **Keys** — a 2048-bit RSA keypair (PKCS8 private / SPKI public PEM),
  generated once with `openssl` and stored in the `seb-now` project's
  Supabase Vault as `ap-actor-private-key` / `ap-actor-public-key`, read
  via a `public.get_vault_secret(secret_name text)` RPC (`execute` is
  revoked from `anon`/`authenticated`, so it's reachable only via the edge
  function's own `service_role` client). Rotating the key means regenerating both
  secrets and redeploying — nothing else references the key material
  directly.

- **Posts are links.** A post is an ordinary `links` row (`origin:
  'local'`, the text as `title`, `author: '@seb@seb.now'`, `url:
  https://seb.now/p/<id>`), so it's ranked, voted on and replied to like any
  link; `public.ap_posts(link_id, delivered_at)` marks which local links are
  federated. Publish with `select public.publish_post('text')`
  (service_role only), which inserts both rows. No deploy is needed: the feed
  is ranked client-side, and `seb.now/p/<id>` is served by the static site's
  catch-all document, whose page script pins that link to the top of the
  feed. The `ap_posts` insert trigger (`ap_posts_request_delivery`)
  `pg_net`-POSTs the function's `/ap/deliver`, which claims every row with
  `delivered_at is null` in one `UPDATE … RETURNING` and sends each as a
  signed `Create(Note)` (public, content HTML-escaped, `url` = the post page)
  to every follower inbox, shared inbox preferred. `/ap/deliver` is
  unauthenticated since it only sends rows already in the table. Posts aren't
  backfilled to later followers. `votes.voter_id`/`replies.author_id` are
  nullable for this: each row has exactly one of a local profile or a
  `remote_actor_id` (check constraints), and RLS still only lets users write
  their own. The actor
  advertises `outbox: https://seb.now/ap/outbox` and notes are
  `https://seb.now/ap/notes?id=<uuid>`, both 308-redirected to the function
  by DO ingress rules like `/ap/actor`'s. Note ids use a query string
  because a DO redirect keeps the query but drops the path after its
  matched prefix (`/ap/notes/<uuid>` would arrive as `/ap/notes`).

- **Readers are accounts too.** Every profile whose `handle` matches
  `^[a-z0-9_]{1,30}$` (the `profiles_handle_format` check; handles were
  already unique) is `@handle@seb.now`, except `seb`, reserved for the site
  actor. WebFinger answers any such handle; the actor is
  `https://seb.now/ap/actor?id=<profile id>` (a query string, for the same
  DO-redirect reason as note ids), with a keypair generated on first use and
  stored in `public.ap_actor_keys` (service_role only). Every local comment
  (a `replies` row) is sent as that account's `Create(Note)` (`id:
  https://seb.now/ap/notes?reply=<reply id>`). On a federated post it's a
  reply (`inReplyTo` the post, mentioning `@seb`) sent to the site's
  followers, the author's followers and every remote actor already voting or
  replying on that post (`remote_actors.inbox_url` / `shared_inbox_url`). On
  any other link it's the reader's own post sharing the link (their text,
  then the link, which Mastodon turns into a preview card), sent to the
  author's followers, and the site actor then `Announce`s it to the site's
  followers, since Mastodon only shows a post to followers of its author. A
  statement trigger on `replies` calls `/ap/deliver-replies`, which runs
  `claim_federated_replies()` to mark each pending comment `ap_state =
  'sent'` or `'local'` (no usable handle, or over
  `REPLIES_FEDERATED_PER_HOUR` per author) and return its link.
  Deleting a sent reply triggers `/ap/delete-reply`, which sends a `Delete`
  only once the row is really gone. Both reply triggers are `security
  definer`, since site users insert/delete replies through RLS and can't
  call `pg_net`. Remote actors can follow a reader's account too
  (`ap_followers.profile_id`; null = the site actor), and remote replies to a
  sent reply land on the same post.

**No addresses in code.** The site's origin, its actor's username and the
Supabase functions base URL live in `public.app_settings` (`site_origin`,
`site_actor_username`, `functions_url`; service_role only, filled per
environment, never by a migration). SQL reads them through
`public.app_setting(key)` (the `ap_posts`/`replies` delivery triggers and
`publish_post`); the `activitypub` function loads them once per boot, with
the same cold-boot retry as its Vault read, and derives every actor, inbox,
outbox and note URL from them; the page script uses `location.host`. The DO
proxies build the Supabase URL from `SUPABASE_URL`, which `project.yml`
passes through from the functions component's env in the app spec. Earlier
migrations that inlined addresses are superseded by the functions redefined
in `20260928190000_fediverse_user_actors.sql`.

**Not built yet**: any automatic boosting. Per the earlier
design discussion, a boost should follow a deliberate human upvote on a
link, not ingestion volume — that wiring (upvote → signed `Announce` to
followers) doesn't exist yet. Also unbuilt: replay/nonce protection on
inbound signatures (a captured, still-valid signed request could be
replayed within its clock-skew tolerance), and a `followers` collection
endpoint (the actor doc omits the `followers` field rather than publish a
dead link).

Verified end-to-end against a real, independently-signed request (a
temporary mock remote actor + keypair, deleted after testing): a properly
signed `Follow` is verified, stored in `ap_followers`, and answered with a
correctly-signed `Accept` delivered back to the follower's inbox — not
just `curl`ing the stub for a canned response.

**HTTP Signature header forwarding through the DO proxy.** The `/ap/inbox`
DO Function must forward the sender's original `Date`, `Digest`, and
`Signature` headers to the Supabase function unmodified (`web: raw`'s
`args.http.headers`, lowercased) — signature verification checks these
exact bytes. Since the request reaches the Supabase function proxied
through an internal DO→Supabase hop (not `seb.now` directly), the
`(request-target)` and `host` values used to reconstruct the sender's
original signing string are **hardcoded** in the Supabase function
(`post /ap/inbox`, `seb.now`) rather than read from the proxied request —
that's what the sender actually signed against, since our own actor
document is what told them `inbox: https://seb.now/ap/inbox` in the first
place.

**DO Functions can't serve the actor — two gateway limits.** DO's
OpenWhisk-based functions gateway (a) 400s any request whose `Accept` header
doesn't allow plain JSON (`application/activity+json`, `ld+json`, `jrd+json`,
even `text/html` → `Incomplete web function path`; no `Accept`, `*/*` or
`application/json` pass), before the function runs, on every function route;
and (b) 400s a `+json`-suffixed response `Content-Type` under `web: raw`
(`Messages.httpContentTypeError`). Mastodon fetches actors with
`Accept: application/activity+json, application/ld+json` and, since its
CVE-2024-23832 fix, only accepts an actor whose response `Content-Type` is
`application/activity+json` (or `ld+json` with the ActivityStreams profile)
— `valid_activitypub_content_type?` in `json_ld_helper.rb`. So a proxied
actor fails both ways. Hence the `/ap/actor` 308 redirect to Supabase, which
sends `application/activity+json`: Mastodon's HTTP client follows up to 3
redirects and only checks that the JSON `id` equals the URL it asked for
(`https://seb.now/ap/actor`), not the final host. The other routes survive
the gateway: Mastodon's WebFinger lookup sends
`Accept: application/jrd+json, application/json` and checks link `type`s in
the body, not the response header (so WebFinger stays `application/json`),
inbox deliveries send no restrictive `Accept`, and MCP clients send
`application/json, text/event-stream`. A new route whose clients send a
non-JSON `Accept` (or need a `+json` response type) should be a redirect to
Supabase too, not a proxied function.

Two non-obvious things had to be right simultaneously for this to route at
all — get either wrong and it silently 404s or 400s even though the build
succeeds:

- **`web: raw`, not `web: true`, in `project.yml`.** `web: true` actions
  build and deploy fine but 400 through App Platform's custom
  `ingress.rules` with OpenWhisk's `Incomplete web function path. The path
  must contain /$namespace/$package/$function` error — `web: raw` actions
  resolve correctly at the same 2-segment `package/function` address.
  Confirmed by finding a working reference app
  (`rarebit-one/rarebit-static-v3`) using the identical pattern. Handlers
  read `args.http.{method,queryString,body,isBase64Encoded,headers}` under
  raw mode (DO's own envelope, not flattened top-level params, and not
  OpenWhisk's classic `__ow_*` keys, though those are also still present
  alongside `http`).
- **The ingress `match.path.prefix` must equal the full target path with
  an empty remainder** — i.e. `rewrite` must fully supply the
  `package/function` address itself, with nothing left over from the
  original request path to append. A broader prefix (e.g. `/ap` catching
  both `/ap/actor` and `/ap/inbox`, rewritten with the remainder appended)
  reproduces the *same* `Incomplete web function path` 400 as `web: true`
  did, even under `web: raw` — DO's rewrite-then-append doesn't resolve to
  a valid function path for functions components, contrary to what the
  App Spec reference's generic rewrite semantics would suggest. Current
  `ingress.rules`: `/.well-known/webfinger` → `rewrite: /wellknown/webfinger`,
  `/ap/inbox` → `rewrite: /ap/inbox`, `/mcp` → `rewrite: /mcp/server`,
  `/mcp/user` → `rewrite: /mcp/user` —
  one exact-match rule per function, not one broader rule per package
  (plus the `/ap/actor`, `/ap/outbox` and `/ap/notes` redirect rules, and
  `/` → the static site last).

Both of these were confirmed by testing against a real, independently
working app with the same shape (not guessed blindly) — if either changes
again in the future (new function added, path changed), extend the same
one-rule-per-function, `web: raw` pattern rather than reintroducing a
broader prefix.

## Review-comment workflow

When the user leaves review comments on an open PR, address them in a loop:

- Spawn one subagent per unresolved comment/thread. Each subagent resolves
  its comment independently (its own diagnosis + fix + push), rather than
  one agent working through the list serially.
- Before spawning, fetch the full list of comments already posted on the
  PR — both resolved and unresolved — so a new subagent doesn't redo work
  another subagent already finished, and doesn't miss context from a
  comment adjacent to the one it's assigned.

## Multi-PR conflict queue

When a new PR is opened (by you or a subagent), before treating it as
ready to merge:

1. Check it for merge conflicts against every other currently open PR,
   not just against the base branch.
2. **No conflict** — proceed normally.
3. **Conflict** — do not resolve it ad hoc by rewriting one PR's history
   against the other. Put the new PR in a queue instead.
4. While a PR sits in the queue, look for a way to split it — or the PR(s)
   it conflicts with — into two independent parts along a boundary that
   shrinks the overlapping surface area (e.g. separate files/modules each
   PR touches). After a split, re-run the conflict check on the resulting
   PRs before letting either out of the queue.

The goal is to minimize merge-conflict surface area between concurrently
open PRs, not to avoid opening PRs — many small, independent PRs are
preferred over one large one.

## Constants, not hardcoded metaparameters

Metaparameters (hyperparameters, thresholds, tolerances, and identifiers
naming an external resource like a model) live in `src/seb_now/constants.py`
as named values — never as bare literals inline in code. A string that
names one of a fixed set of external things (e.g. a pretrained model id)
is a `StrEnum` member there, not a raw string.

In particular, a call that instantiates a class (`nn.MultiheadAttention(...)`,
`SentenceTransformer(...)`) must not take a literal
`int`/`float`/`str`/`bool` argument — reference a name from `constants.py`
instead. `tests/test_constants_convention.py` asserts this in CI by
AST-scanning `src/seb_now/*.py` and `research/*.py` for class-instantiation
calls with literal arguments (not `tests/`, where literal fixtures are
normal pytest style, and not stdlib idioms like `TypeVar("V")`, where the
literal *is* the name rather than a metaparameter — see the exclusion list
in that test for the exact scope).

This does not extend to every literal anywhere (`range(0, n)`, `.unsqueeze(0)`,
a `torch.manual_seed(0)` reproducibility seed) — only to values instantiating
a class where the choice of value is itself a design decision worth naming.

## Data lives in tables, not module-level collections

A list, tuple, set or dict written out at module scope is usually *data*
(which domains are mainstream media, which channels to follow), and data
belongs in a Supabase table the code reads — e.g. `public.sources` for the
ingest functions, `public.domain_source_types` for `classify_source` (which
takes the mapping as an argument; `site.py` loads it at build time).
`tests/test_no_module_level_collections.py`
(`test_no_list_declaration_in_outer_scope`) AST-scans `src/seb_now/*.py` and
`research/*.py` for module-level collection literals, including
`frozenset({...})`-style wrappers and comprehensions. A collection that is
genuinely code (an escape table, a security allowlist) goes in that test's
`ALLOWED` with a one-line reason; stale `ALLOWED` entries fail the test too.
The rule is Python-only — `ast` can't read the TypeScript Edge Functions, whose
module-level arrays today are protocol/schema (MCP `TOOLS`, header lists), not
data.
