# Phase-vector name matching vs `entity_candidates` (SEB-9)

`phase_ngrams_eval.py` on a read-only snapshot taken 2026-10-18 through
`phase_ngrams_eval.sql`: 25,953 non-source entity names, and 2,371 queries
(distinct query text per target set) built from the data:

- **surface** (1,163): a `link_entities.surface` that differs from its
  entity's name, to that entity.
- **witness** (434): an `identity_witnesses` label that differs from the
  name and isn't already a surface.
- **merge** (774): a `merge` row in `entity_edits`, the merged-away name to
  the kept entity, with the merged-away entity left out of the ranking. None
  are applied yet: all are staged (claude for articles, jev for Wikidata), so
  these are unreviewed labels.

**No hard negatives.** `entity_edits` has no `keep` rows (only staged
`merge` and `drop_mention`), so the false-match rate on alike-but-different
names couldn't be measured. Precision at the threshold below is precision on
the positives' queries: how often the top match is a right one.

Every method except `entity_candidates` ranks the same index, entity names
only. `entity_candidates` also indexes mention surfaces and label witnesses,
which is where the surface and witness queries come from, so its row is a
ceiling for "remembering aliases", not a fair comparison of the encodings.
Latency for the two SQL rows is server-side time per call (`clock_timestamp()`
around it); for the others it's this machine's in-process time per query (4
cores, numpy brute force over all 25,953 vectors, no index).

k = 8 (`entity_candidates`' `max_results`). "P@matched coverage" ranks
queries by top-1 score and takes as many as pg_trgm's names branch covers at
its 0.3 threshold (99.7%), so score scales don't matter.

| method | recall@8 | MRR@8 | recall merge | recall surface | recall witness | P@0.3 (coverage) | P@matched coverage | ms p50 | ms p95 |
|---|---|---|---|---|---|---|---|---|---|
| `entity_candidates` (names + aliases) | 0.981 | 0.965 | 0.942 | 1.000 | 1.000 | 0.954 (0.998) | 0.955 | 6.75 | 17.51 |
| pg_trgm, names only (SQL, 0.3) | 0.962 | 0.829 | 0.942 | 0.961 | 0.998 | 0.749 (0.997) | 0.749 | 1.67 | 4.61 |
| trigram Jaccard, folded, no cut | 0.965 | 0.832 | 0.951 | 0.963 | 0.998 | 0.752 (0.998) | 0.752 | 1.71 | 2.35 |
| exact trigram cosine | 0.969 | 0.844 | 0.950 | 0.970 | 1.000 | – | 0.763 | 0.66 | 0.90 |
| exact trigram cosine, IDF | 0.968 | 0.847 | 0.955 | 0.965 | 0.998 | – | 0.773 | 0.66 | 0.86 |
| phase d=256 | 0.968 | 0.839 | 0.951 | 0.968 | 0.995 | – | 0.759 | 8.95 | 13.26 |
| phase d=256, IDF | 0.964 | 0.847 | 0.951 | 0.960 | 0.998 | – | 0.772 | 8.17 | 12.92 |
| phase d=256, IDF, + whole words | 0.966 | 0.850 | 0.950 | 0.964 | 1.000 | – | 0.775 | 8.51 | 12.87 |
| phase d=1024, IDF | 0.966 | 0.847 | 0.955 | 0.962 | 0.998 | – | 0.773 | 58.83 | 78.11 |

SimHash as an LSH prefilter (64 bits in 16 bands of 4, phase d=256 IDF, 500
queries): recall@8 0.954, but 65% of all entities share a band with the query,
so it prunes almost nothing.

## Reading it

- **Recall@8 doesn't move.** Every names-only method lands at 0.962–0.969;
  with 2,371 queries one standard error is about 0.004, so the phase vector's
  0.964–0.968 is a tie with pg_trgm's 0.962, not a win. The misses are
  aliases with no shared spelling (acronyms, translations, a first name for a
  full name), which no trigram encoding can find.
- **The small MRR and precision gain is cosine and IDF, not the phases.**
  Phase d=256 IDF (MRR 0.847, P 0.772) equals the exact IDF-weighted cosine it
  estimates (0.847, 0.773). Going from Jaccard to cosine is worth +0.012 MRR,
  IDF another +0.003; the hashed encoding then costs nothing at d=256 and
  d=1024 adds nothing. Whole words as extra tokens: +0.003 MRR, within noise.
- **What does move the numbers is remembering aliases.** `entity_candidates`
  is far ahead (MRR 0.965, P 0.954) because it indexes the surfaces it has
  seen. Partly leakage here (a surface query finds itself), but it is also the
  real mechanism, and a phase index could hold the same aliases.
- **Latency.** Brute force over 25,953 vectors takes 8 ms at d=256 in numpy,
  against 1.7 ms for the GIN-indexed names branch and 6.8 ms for the whole
  function. Different machines, but nothing here is faster than the index
  already in place. d=1024 is 7x slower for no gain.
- **Order.** The algebra holds as tested (`test_phase_ngrams.py`), with one
  correction to the analysis comment: e^{iθ_a}·e^{iθ_b}·e^{iω} commutes, so it
  can't carry bigram order; permuting the second token's coordinates before
  binding does. RoPE's geometric spectrum (base 10,000) barely separates a
  short-range swap (similarity stays about 0.96 for a 3-word swap), so for
  titles the ordered bigrams are the order signal. Neither was needed for names.

## Conclusion

It does not beat the baseline. On recall@8, the bar the analysis set for
shipping, the phase vector ties pg_trgm (0.964–0.968 vs 0.962, within one
standard error), and it is slower than the trigram index. Its small MRR and
precision edge comes from cosine plus IDF weighting. pg_trgm could get the
same by re-ranking its candidates, without a new representation. The one
reason left to build it is deployment: a fixed-size vector the page's entity
index could ship for client-side matching. The data here says that's a
packaging choice, not a quality gain. Measuring the false-match rate needs
`keep` rows first.
