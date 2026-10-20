# research

Experiments that aren't part of the site. Nothing under `src/seb_now` imports
from here.

- `algebra.py` — `Combinable`, a checker for whether a text embedding is
  compositional (`embed(x ⊕ y) ≈ embed(x) + embed(y)`), with each
  precondition tested separately. See its module docstring.
- `real_embedding_check.py` — runs that checker against a real
  sentence-transformer (downloads ~90MB).
- `train_compositional_embedding.py` — trains a tiny attention model with the
  homomorphism law as its loss, then re-checks it.
- `kind_probe.py` — linear probe: how much of an entity's kind (`kind_path`)
  is readable from its bare name, by character n-grams and by a frozen
  multilingual embedding, per depth of the kind tree, against a shuffled-label
  control. Reads `public.entities` with the anon key from `.env`.
- `kind_predicates.py` — one independent yes/no probe per kind ("is it an
  org?"), so a name can be several kinds at once; reports AUC per predicate
  against a control, and which predicates fire together.
- `phase_ngrams.py` — hashed phase vectors over folded character trigrams
  (SEB-9): each token is d hash-seeded phases on the torus, a name is their
  IDF-weighted sum, similarity is Re⟨u, v⟩, binding is elementwise
  multiplication, with RoPE-style order and SimHash bits.
  `phase_ngrams_eval.py` scores it for name matching against
  `entity_candidates`, from the snapshot `phase_ngrams_eval.sql` reads;
  results in `phase_ngrams_results.md`.
- `test_*.py` — collected by the normal `pytest` run.
- `jev/` — prototype: noun-phrase relations judged by TypeSafe's Jev, emitted
  as PLN links in MeTTa. See its own README.

The scripts need the `research` dependency group:

    uv run --group research python research/real_embedding_check.py
