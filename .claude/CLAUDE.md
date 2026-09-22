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
