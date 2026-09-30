# jev — term logic from text with TypeSafe's Jev, emitted as PLN/MeTTa

Prototype, not used by the site. It asks Jev (TypeSafe's System One model)
typed questions about noun phrases in a text and turns the answers into PLN
links, written as MeTTa for OpenCog Hyperon.

- `jev_fill.py` — `JevForm`: builds Jev questions from a pydantic model
  (`DescribedStrEnum` field → Choice, `DescribedIntEnum` → Score, `bool` →
  Noul; the field description is the question) and parses answers back.
- `terms.py` — the relation model: `Extension` (same reference, member,
  inherits, overlap, excludes, no reference), `Share` for graded overlap,
  `Kind` (individual / kind / group), `HasProperty` for intension, and the
  mapping to PLN links (`Subset`, `Member`, `Identical`,
  `ExtensionalSimilarity`, `IntensionalInheritance`, …) and MeTTa.
- `text_pairs.py` — the same over phrases in a text: each phrase is located
  by an id marker in the state plus a window of words around it
  (`Locate.BOTH`, the most accurate in tests), and one kind question per phrase
  rides along with the pair questions.
- `entities.py` — merges mentions that pick out the same thing (union-find at
  P(same) ≥ 0.7) into entity nodes and combines mention-level links with PLN
  revision.
- `coref.py` — the earlier Frege-style pairwise version with its cost model.
- `run_text.py`, `run718.py` — rebuild MeTTa from saved live answers
  (`answers*.json`, fetched through the database since this sandbox couldn't
  reach the API); `query.py` loads the result into Hyperon and queries it.
- `fake_client.py`, `example.py` — offline smoke runs with a stand-in client.

Run from this directory (the modules import each other flat), with
`pydantic`, `typesafe-sdk` and, for `query.py`, `hyperon` installed:

    cd research/jev && python run_text.py

This folder is outside the `research/*.py` glob that
`tests/test_constants_convention.py` and `test_no_module_level_collections.py`
scan, and it doesn't follow those conventions yet (its constants and tables
are module-level). Bring it in line before anything here moves into the site.

Findings so far: intension works as one Noul per (term, property) with the
overlap computed in code — asking Jev for "the share of B's properties A has"
directly collapses its confidence. Locating a phrase by marker plus word window
beat either alone on a text with a repeated "the bank". A per-phrase
kind-or-individual question, enforced in code, fixed every member-vs-kind
confusion on generics ("the blue whale").
