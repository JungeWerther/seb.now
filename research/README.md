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
- `data/topic_label_calibration_2026-10-14.csv` — `topic-label`'s `dry_run`
  output on 200 hand-labelled links: every beam leaf (`node`, Jev's `score`,
  whether it passed `MIN_LABEL_SCORE` as `jev_labelled`), whether it matches a
  hand label on that link (same topic, or one an ancestor of the other, as
  `matches_hand_label`) and the hand labels at the time. 7 rows are Jev's "none
  of these". The `topic-label` row of `public.evidence_sources` was fitted on
  it: `σ(0.5·logit(score) − 0.25)` at weight 16.
- `jev/` — prototype: noun-phrase relations judged by TypeSafe's Jev, emitted
  as PLN links in MeTTa. See its own README.

The scripts need the `research` dependency group:

    uv run --group research python research/real_embedding_check.py
