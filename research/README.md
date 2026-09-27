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
- `test_*.py` — collected by the normal `pytest` run.

The scripts need the `research` dependency group:

    uv run --group research python research/real_embedding_check.py
