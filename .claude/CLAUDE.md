# seb.now — project instructions

## What this is

`seb.now` — a news website. Currently scaffolded as a bare `uv`-managed
Python package (`src/seb_now`); no web framework has been chosen yet.

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
