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
picks it up (a DB-only change doesn't itself trigger a rebuild — only a
push to `main` or an explicit `do-api` deployment call does).

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
ingest functions don't peek at target pages. `site.py` renders a 36px
thumbnail next to the title when `image_url` is set.

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

**ActivityPub proxy (scaffolding, not live yet — routing unresolved).**
`fediverse-ingest` above only ever *reads* from the fediverse (Mastodon's
public REST API). Becoming a followable ActivityPub actor at `@seb@seb.now`
needs the opposite direction too — but WebFinger resolution for that handle
requires `GET https://seb.now/.well-known/webfinger` to be answered by
something at that exact host, which a static site can't do on its own.
`functions/` is a DigitalOcean Functions project (a `functions`-type App
Platform component, free under DO's per-team 90,000 GiB-second/month
allowance) added to the app spec to give `seb.now` real endpoints at that
host: `/.well-known/webfinger`, `/ap/actor`, `/ap/inbox`, routed there via
`ingress.rules` entries (`/.well-known` needs an explicit `rewrite` to
`/wellknown`, since `.` isn't a valid DO Functions package name; `/ap`
rewrites to `/ap`, identity, since its sub-paths already are valid function
names). Each function is meant to be a thin proxy forwarding to the
`activitypub` Supabase Edge Function and relaying the response back
unchanged, keeping the actual protocol logic in one runtime. That Supabase
function is a stub (501 on every known path) — real ActivityPub behavior
(actor identity, HTTP Signatures, a followers table, outbound delivery,
likely via Fedify) is unbuilt.

**Known-broken: the functions component builds but does not route.**
`nodejs:20` isn't a valid DO Functions runtime (fixed to `nodejs:22` —
valid values are 14/18/22/24, confirmed via DO docs); with that fixed, the
`activitypub` functions component now builds and deploys successfully
(`Deployed actions: ap/actor, ap/inbox, wellknown/webfinger`, confirmed
from the build log). But every request through the custom `ingress.rules`
above still 404s ("The requested resource does not exist.") or, with a
too-short rewrite target, 400s with OpenWhisk's
`Incomplete web function path. The path must contain
/$namespace/$package/$function`. That error confirms DO's functions
gateway wants a 3-segment `namespace/package/function` path, not just
`package/function` — but the functions component's `namespace` (visible
per-deployment as `active_deployment.functions[0].namespace`, e.g.
`ap-<uuid>`, and **regenerated on every rebuild**, including a
`force_build` with no spec change) tried in that position was
systematically tested — the real, freshly-fetched current value, the
component name, the app id, the `x-do-app-origin` response header value,
and the namespace UUID without its `ap-` prefix — and **all five 404'd**.
The ingress spec is currently reverted to the simplest docs-literal form
(`rewrite: /wellknown` / `rewrite: /ap`, 2 segments, matching the deployed
action names exactly) rather than left with a guessed value baked in. This
is either an undocumented DO App Platform quirk (functions-component
ingress may need a mechanism this session couldn't find in public docs) or
requires DO support to resolve — don't re-guess namespace values without
new information; if picking this back up, start from DO support or a
working reference app, not more trial-and-error redeploys. The `inbox`
function's `web: true` action auto-parses the JSON body into params rather
than exposing it raw, which loses the byte-for-byte fidelity real
signature verification needs — fine for a stub, but switch to `web: raw`
when inbox processing becomes real.

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
`SentenceTransformer(...)`, `TopicClusterer(...)`) must not take a literal
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
