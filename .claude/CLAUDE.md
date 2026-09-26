# seb.now — project instructions

## What this is

`seb.now` — a news website. Currently scaffolded as a bare `uv`-managed
Python package (`src/seb_now`); no web framework has been chosen yet.

## Infrastructure: Supabase + DigitalOcean

**Storage — Supabase.** Project `seb-now`, ref `yoxrhqlzsqwfjmsjpari`, org
"Seb Private" (`jlizhkmtqqlztnjcknso`), region `eu-west-1`, URL
`https://yoxrhqlzsqwfjmsjpari.supabase.co`. This is a dedicated project —
deliberately separate from the `bhewgqnzhyllvxcdmjrd` project (personal
CRM + EventMCP) so a public-facing site's anon key never shares a database
with private data. Access it with the `mcp__Supabase__*` tools using that
project ref; there is no CLI/local Supabase link in this repo.

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
for the integration test. The static site itself (browser client, and
`site.py`'s build-time read) never uses `service_role` — every user
write goes through RLS as an authenticated (including anonymous) user.
The one exception is `service_role` inside the three ingestion Edge
Functions (see below) — server-side only, never shipped to a client.

**Ingestion — three Edge Functions, each on its own `pg_cron` schedule,
all inside the `seb-now` project itself** (unlike the DO deploy trigger,
these don't need the personal CRM project or its vault secret, since
they call their own project's own functions):

- `fediverse-ingest` (`0 */6 * * *`) — pulls recent public posts from a
  fixed list of Mastodon accounts (`ACCOUNTS` in
  `supabase/functions/fediverse-ingest/index.ts`; currently
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
page's first `<img>`. HN/TechCrunch links leave `image_url` null - their
ingest functions don't peek at target pages. Each article row has a
left favicon column (`FAVICON_URL_TEMPLATE`, DuckDuckGo's icon service,
falling back to the host's first letter); the domain, title row and — when
`image_url` is set — a clickable 16:9 cover image share the indented
column to its right, cover below the title.

Both upsert into `links` as `origin: 'feed'`, `onConflict: 'url'` (falling
back to the HN item's own discussion-page URL when a story has no
external `url`, e.g. Ask HN). `links.url` and `links.fediverse_post_uri`
both have plain (non-partial) unique indexes for this — note PostgREST's
`upsert(onConflict:)` can't resolve against a *partial* unique index
(Postgres won't infer the conflict target through an unstated `WHERE`),
which is why these are full indexes rather than e.g.
`... where fediverse_post_uri is not null` — harmless here since `NULL`
never collides with `NULL` under uniqueness anyway.

The three schedules are staggered 15 minutes apart (`:00`/`:15`/`:30`)
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
decision model, planned, not yet automated — so new ingested links
currently arrive untagged). Both tables are public-read, service_role-write.

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
round reply button (bottom right of the post box) that swaps the search
bar for a reply composer in the same dock; replies are loaded
client-side and listed under the post. No moderation or rate limiting
yet — anyone with an anonymous session can post.

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
not heading upward: the card is only picked up once the gesture has
run `SWIPE_START_DECIDE_MS` (and moved `SWIPE_CAPTURE_SLOP_PX`), and if at
any point in that window it is vertical-dominant or climbs steeper than
`SWIPE_START_MAX_UP_DEG`, it is the feed being scrolled and is dropped for
good, even if it turns sideways later; once
it has, a non-passive `touchmove` handler blocks scrolling for the rest
of the gesture so the browser can't cancel it mid-drag. Pointer events
only update the finger's target position; a single rAF loop eases the
drawn card toward it (exponential follow, `SWIPE_SMOOTHING_MS` time
constant, frame-rate independent) so uneven event delivery can't make it
jitter. Vote decisions use the finger's target, not the eased position.
Below the vote threshold the tint only previews (up to
`SWIPE_TINT_PREVIEW_OPACITY`, icon and label dimmed); the moment the
finger's target crosses it the tint gets `.armed` — full opacity, the icon
pops, one light sheen sweeps across in the swipe direction, and a short
`navigator.vibrate` where supported — and loses it again if dragged back,
so "release now counts" is unambiguous. `--post-bg` must stay
opaque for the same reason (a translucent post would show the tint
through it). The handler only takes pointer capture once the pointer has
moved `SWIPE_CAPTURE_SLOP_PX`, and never starts on a `<button>` —
capturing on `pointerdown` retargets a plain tap's `click` to the swipe
area, so links and buttons inside would never receive it.

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

A second Supabase project on this account, `trading.swiechers.nl`
(`fvtapzjbxkqvmikdapla`, org `qiliecndqbdzhhdlcvgv`), was **paused** to
free a free-tier project slot for `seb-now` — unrelated to this app, but
worth knowing before assuming it's still active.

**ActivityPub proxy — real actor, not a stub.** `fediverse-ingest` above
only ever *reads* from the fediverse (Mastodon's public REST API).
Becoming a followable ActivityPub actor at `@seb@seb.now` needs the
opposite direction too — but WebFinger resolution for that handle requires
`GET https://seb.now/.well-known/webfinger` to be answered by something at
that exact host, which a static site can't do on its own. `functions/` is
a DigitalOcean Functions project (a `functions`-type App Platform
component, free under DO's per-team 90,000 GiB-second/month allowance)
added to the app spec to give `seb.now` real endpoints at that host:
`/.well-known/webfinger`, `/ap/actor`, `/ap/inbox`. Each function is a
thin proxy forwarding to the `activitypub` Supabase Edge Function and
relaying the response back unchanged, keeping the actual protocol logic in
one runtime.

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
- **Inbox** (`POST /ap/inbox`) — verifies the sender's HTTP Signature
  (draft-cavage, RSA-SHA256 over `(request-target) host date digest`,
  fetching the sender's own actor doc for their public key), then:
  `Follow` → upserts into `ap_followers` and delivers a signed `Accept`
  back to the follower's inbox; `Undo` of a `Follow` → deletes the
  follower row. Everything else (`Like`, `Announce`, `Create`, `Delete`,
  ...) is accepted (202) and logged, not acted on.
- **Keys** — a 2048-bit RSA keypair (PKCS8 private / SPKI public PEM),
  generated once with `openssl` and stored in the `seb-now` project's
  Supabase Vault as `ap-actor-private-key` / `ap-actor-public-key`, read
  via a `public.get_vault_secret(secret_name text)` RPC (mirrors the
  personal-CRM project's `do-api` pattern; `execute` is revoked from
  `anon`/`authenticated`, so it's reachable only via the edge function's
  own `service_role` client). Rotating the key means regenerating both
  secrets and redeploying — nothing else references the key material
  directly.

**Not built yet**: an outbox, or any automatic boosting. Per the earlier
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

**Another DO gateway quirk: reject `+json` response Content-Types.**
WebFinger and the actor document are spec-correctly `application/jrd+json`
and `application/activity+json` in `handleWebfinger`/`handleActor`'s JSON
*data* (the `links[].type`/context fields), but the actual HTTP response
`Content-Type` **header** for both is plain `application/json` — DO's
OpenWhisk-based functions gateway 400s
(`Messages.httpContentTypeError`, `"Response type in header did not match
generated content type."`) on a `+json`-suffixed response header under
`web: raw`, even though the JSON body itself is fine (traced to
`WebActions.scala` in `apache/openwhisk`; DO's fork evidently diverges
from upstream's `isJsonFamily` handling here). Real ActivityPub/WebFinger
clients negotiate content on `Accept`, not a strict response
`Content-Type` match, so this doesn't break federation — but don't
"fix" these back to the spec-correct MIME type without re-testing through
the live DO route, not just against Supabase directly (Supabase alone
never reproduces this — it's DO's gateway specifically).

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
  `/ap/actor` → `rewrite: /ap/actor`, `/ap/inbox` → `rewrite: /ap/inbox` —
  one exact-match rule per function, not one broader rule per package.

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
AST-scanning `src/seb_now/*.py` and `examples/*.py` for class-instantiation
calls with literal arguments (not `tests/`, where literal fixtures are
normal pytest style, and not stdlib idioms like `TypeVar("V")`, where the
literal *is* the name rather than a metaparameter — see the exclusion list
in that test for the exact scope).

This does not extend to every literal anywhere (`range(0, n)`, `.unsqueeze(0)`,
a `torch.manual_seed(0)` reproducibility seed) — only to values instantiating
a class where the choice of value is itself a design decision worth naming.
