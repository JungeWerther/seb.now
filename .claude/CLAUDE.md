# seb.now — project instructions

## What this is

`seb.now` — a news website. `src/seb_now` is a `uv`-managed Python package
whose core is `TopicClusterer` (in `clustering.py`, built on the
`Combinable` law-check in `algebra.py`): it groups article/headline text
into topics via a compositional embedding, checked for correctness before
use so incremental clustering can't silently go order-dependent.

`site.py` is the frontend: it fetches live headlines from the RSS feeds in
`constants.py`'s `NewsFeed` enum, derives a bag-of-words vocabulary from
whatever came back (a vocab hardcoded for one day's headlines means
nothing against tomorrow's), runs them through `TopicClusterer`, and
renders the result via the Jinja2 template in `src/seb_now/templates/` —
a static site, no server-side framework. See "Deployment" below for how
that output actually reaches seb.now.

## Deployment

Hosting is DigitalOcean App Platform, app `seb-now` (id
`959be812-add5-43f2-8b34-9199bde072a1`, region `lon`), free static-site
tier. It tracks this repo's `claude/enable-seb-now-domain-0wirwy` branch
with `deploy_on_push: true` — **pushing a commit to that branch is the
entire deploy step**, no extra action needed. Build command is
`uv run python -m seb_now.site dist` (Python buildpack; `uv sync` installs
deps from `pyproject.toml` before the custom command runs — don't use
`pip` in the build command, it isn't on `PATH` in this buildpack).
`seb.now` and `www.seb.now` are wired to the app as custom domains, DNS
hosted on DigitalOcean (nameservers point there).

Independent of pushes, a Supabase `pg_cron` job (`seb-now-rebuild`, id 2,
`*/30 * * * *`, in project `bhewgqnzhyllvxcdmjrd`) force-rebuilds the app
every 30 minutes so the homepage's headlines/clustering stay current even
with no code changes. Change the schedule with
`select cron.alter_job(2, schedule := '...')` in that project.

There is no DigitalOcean MCP connector in this environment. All DO API
access (checking deploy status, reading build logs, changing the app
spec, forcing a rebuild) goes through that same Supabase project's
`pg_net` extension plus two edge functions, using a vault-stored token a
caller never sees directly:
- SQL: `select net.http_get(url := 'https://api.digitalocean.com/v2/...', headers := jsonb_build_object('Authorization', 'Bearer ' || public.get_vault_secret('digitalocean-infra-key')));`
  then read the response from `net._http_response where id = <request_id>`
  (pg_net is async — post, then poll).
- `net.http_post`/`net.http_get` only; there's no `net.http_put` in this
  pg_net version. For a PUT (e.g. updating the app spec), route it
  through the `do-api` edge function instead: `net.http_post` to
  `https://bhewgqnzhyllvxcdmjrd.supabase.co/functions/v1/do-api` with
  `Authorization: Bearer <anon_key vault secret>` and body
  `{"method": "PUT", "path": "/apps/...", "body": {...}}` — that function
  does the actual DO fetch server-side with the real method.
- DO build logs come back as a presigned URL to a gzip file; pg_net can't
  decompress binary, so fetch it through the `do-log-fetch` edge function
  (same auth pattern, body `{"url": "<presigned log url>"}`) which
  gzip-decodes and returns text.

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
