"""Score phase-vector name matching against entity_candidates (SEB-9).

Reads the two JSON files phase_ngrams_eval.sql describes (a snapshot of the
entity names and of the matching pairs with both SQL baselines' rankings) and
ranks every non-source entity name for each query with:

- `entity_candidates`: the deployed function. It also indexes mention surfaces
  and label witnesses, which is where most of the positives come from, so its
  numbers are an upper bound, not a fair comparison.
- `pg_trgm names`: the function's names branch alone (`lower(name) % q`, 0.3).
- `jaccard`: the same trigram Jaccard over folded names, without the 0.3 cut.
- `cosine`: the exact (IDF-)weighted cosine of the trigram sets, which the
  phase vector estimates.
- `phase d=…`: the hashed phase vector of phase_ngrams.py.

Every method but entity_candidates sees the same index: entity names only.
Prints recall@k, MRR@k, precision at the 0.3 threshold and at the coverage
pg_trgm gets there, and latency.

    uv run --group research python research/phase_ngrams_eval.py DATA_DIR
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import phase_ngrams as pn
from constants import (
    MATCH_EVAL_SEED,
    MATCH_EVAL_SELF_CHECK_NAMES,
    MATCH_EVAL_SIMHASH_BANDS,
    MATCH_EVAL_SIMHASH_QUERIES,
    MATCH_EVAL_TOP_K,
    MATCH_EVAL_TRGM_THRESHOLD,
    PHASE_DIM,
    PHASE_DIM_LARGE,
    SIMHASH_BITS,
)
from scipy import sparse

if TYPE_CHECKING:
    from collections.abc import Callable

    from numpy.typing import NDArray

Ranking = list[tuple[int, float]]


@dataclass
class Query:
    text: str
    source: str
    self_seq: int | None
    targets: set[int] = field(default_factory=set)
    sql: dict[str, Ranking] = field(default_factory=dict)
    sql_ms: dict[str, float] = field(default_factory=dict)


def load(data_dir: Path) -> tuple[list[int], list[str], list[Query]]:
    entities = json.loads((data_dir / "entities.json").read_text())
    rows = json.loads((data_dir / "baseline.json").read_text())
    by_key: dict[tuple[str, int | None], Query] = {}
    for (
        source,
        text,
        target,
        self_seq,
        candidates,
        names,
        ms_candidates,
        ms_names,
    ) in rows:
        key = (text.lower(), self_seq)
        query = by_key.get(key)
        if query is None:
            query = by_key[key] = Query(text, source, self_seq)
            query.sql["entity_candidates"] = [
                (s, p) for s, p in candidates or [] if s != self_seq
            ]
            query.sql["pg_trgm names"] = [
                (s, p) for s, p in names or [] if s != self_seq
            ]
            query.sql_ms = {
                "entity_candidates": ms_candidates,
                "pg_trgm names": ms_names,
            }
        query.targets.add(target)
    return [s for s, _ in entities], [n for _, n in entities], list(by_key.values())


@dataclass
class Index:
    """Token columns and IDF over the entity names, for one tokenization."""

    names: list[str]
    with_words: bool
    columns: dict[str, int] = field(init=False)
    idf: pn.Idf = field(init=False)
    binary: sparse.csr_matrix = field(init=False)

    def __post_init__(self) -> None:
        self.idf = pn.Idf(self.names, self.with_words)
        self.columns = {t: i for i, t in enumerate(sorted(self.idf.df))}
        rows, cols = [], []
        for r, name in enumerate(self.names):
            for t in pn.tokens(name, self.with_words):
                rows.append(r)
                cols.append(self.columns[t])
        self.binary = sparse.csr_matrix(
            (np.ones(len(rows)), (rows, cols)),
            shape=(len(self.names), len(self.columns)),
        )

    def idf_vector(self) -> NDArray:
        return np.array(
            [self.idf(t) for t in sorted(self.columns, key=self.columns.get)]
        )


def jaccard_scorer(index: Index) -> Callable[[str], NDArray]:
    sizes = np.asarray(index.binary.sum(axis=1)).ravel()

    def score(text: str) -> NDArray:
        toks = pn.tokens(text, index.with_words)
        cols = [index.columns[t] for t in toks if t in index.columns]
        inter = np.asarray(index.binary[:, cols].sum(axis=1)).ravel()
        return inter / np.maximum(sizes + len(toks) - inter, 1)

    return score


def cosine_scorer(index: Index, use_idf: bool) -> Callable[[str], NDArray]:
    w = index.idf_vector() if use_idf else np.ones(len(index.columns))
    weighted = index.binary.multiply(w).tocsr()
    norms = np.sqrt(np.asarray(weighted.multiply(weighted).sum(axis=1)).ravel())
    idf = index.idf if use_idf else None

    def score(text: str) -> NDArray:
        q = pn.weights(text, idf, index.with_words)
        q_norm = math.sqrt(sum(v * v for v in q.values())) or 1.0
        vec = np.zeros(len(index.columns))
        for t, v in q.items():
            if t in index.columns:
                vec[index.columns[t]] = v
        return (weighted @ vec) / np.maximum(norms * q_norm, 1e-12)

    return score


def token_phasors(tokens: list[str], d: int) -> NDArray:
    quanta = np.stack(
        [
            np.frombuffer(pn.phase_digest(pn.TOKEN_SEED_PREFIX + t, d), dtype="<u2")
            for t in tokens
        ]
    )
    return np.exp(1j * quanta.astype(np.float64) * pn.TURN_PER_QUANTUM).astype(
        np.complex64
    )


@dataclass
class PhaseIndex:
    index: Index
    d: int
    use_idf: bool
    vectors: NDArray = field(init=False)

    def __post_init__(self) -> None:
        ordered = sorted(self.index.columns, key=self.index.columns.get)
        w = self.index.idf_vector() if self.use_idf else np.ones(len(ordered))
        table = token_phasors(ordered, self.d)
        raw = self.index.binary.multiply(w).tocsr() @ table
        self.vectors = (raw / np.linalg.norm(raw, axis=1, keepdims=True)).astype(
            np.complex64
        )
        self.table = table

    def encode(self, text: str) -> NDArray:
        q = pn.weights(
            text, self.index.idf if self.use_idf else None, self.index.with_words
        )
        known = [
            (self.index.columns[t], v) for t, v in q.items() if t in self.index.columns
        ]
        unknown = [t for t in q if t not in self.index.columns]
        vec = np.zeros(self.d, dtype=np.complex64)
        if known:
            cols, ws = zip(*known, strict=True)
            vec += np.asarray(ws, dtype=np.float32) @ self.table[list(cols)]
        if unknown:
            vec += np.asarray(
                [q[t] for t in unknown], dtype=np.float32
            ) @ token_phasors(unknown, self.d)
        n = np.linalg.norm(vec)
        return vec / n if n else vec

    def score(self, text: str) -> NDArray:
        return (self.vectors.conj() @ self.encode(text)).real

    def self_check(self, sample: list[int]) -> float:
        idf = self.index.idf if self.use_idf else None
        return max(
            float(
                np.max(
                    np.abs(
                        self.vectors[i]
                        - np.asarray(
                            pn.encode(
                                self.index.names[i], self.d, idf, self.index.with_words
                            )
                        )
                    )
                )
            )
            for i in sample
        )


def top_k(
    scores: NDArray,
    seqs: NDArray,
    exclude: int | None,
    k: int,
    position: dict[int, int],
) -> Ranking:
    scores = scores.copy()
    if exclude is not None and exclude in position:
        scores[position[exclude]] = -np.inf
    picked = np.argpartition(-scores, k)[: k * 2]
    order = sorted(picked, key=lambda i: (-scores[i], seqs[i]))[:k]
    return [(int(seqs[i]), float(scores[i])) for i in order]


@dataclass
class Metrics:
    recall: float
    mrr: float
    precision_at_threshold: float | None
    coverage_at_threshold: float | None
    precision_at_matched_coverage: float
    recall_by_source: dict[str, float]


def measure(
    queries: list[Query],
    rankings: list[Ranking],
    threshold: float | None,
    coverage: float,
) -> Metrics:
    hits, rr, by_source = [], [], defaultdict(list)
    for q, ranking in zip(queries, rankings, strict=True):
        rank = next(
            (
                i
                for i, (s, _) in enumerate(ranking[:MATCH_EVAL_TOP_K], 1)
                if s in q.targets
            ),
            None,
        )
        hits.append(rank is not None)
        rr.append(1 / rank if rank else 0.0)
        by_source[q.source].append(rank is not None)
    tops = [
        (r[0][1], r[0][0] in q.targets) if r else (-math.inf, False)
        for q, r in zip(queries, rankings, strict=True)
    ]
    tops.sort(key=lambda t: -t[0])
    covered = tops[: round(coverage * len(tops))]
    at_threshold = [ok for s, ok in tops if threshold is not None and s >= threshold]
    return Metrics(
        recall=statistics.mean(hits),
        mrr=statistics.mean(rr),
        precision_at_threshold=statistics.mean(at_threshold) if at_threshold else None,
        coverage_at_threshold=len(at_threshold) / len(tops)
        if threshold is not None
        else None,
        precision_at_matched_coverage=statistics.mean(ok for _, ok in covered)
        if covered
        else 0.0,
        recall_by_source={s: statistics.mean(v) for s, v in sorted(by_source.items())},
    )


def timed(
    scorer: Callable[[str], NDArray],
    queries: list[Query],
    rank: Callable[[NDArray, Query], Ranking],
) -> tuple[list[Ranking], list[float]]:
    rankings, ms = [], []
    for q in queries:
        start = time.perf_counter()
        ranking = rank(scorer(q.text), q)
        ms.append((time.perf_counter() - start) * 1000)
        rankings.append(ranking)
    return rankings, ms


def simhash_codes(vectors: NDArray, bits: int) -> NDArray:
    planes = np.asarray(
        [pn.plane(i, vectors.shape[1]) for i in range(bits)], dtype=np.float32
    )
    real = np.concatenate([vectors.real, vectors.imag], axis=1)
    return (real @ planes.T) >= 0


def simhash_prefilter(
    phase: PhaseIndex, queries: list[Query], seqs: NDArray, position: dict[int, int]
) -> tuple[float, float]:
    """Recall@k when only entities sharing a SimHash band with the query are ranked."""
    codes = simhash_codes(phase.vectors, SIMHASH_BITS)
    width = SIMHASH_BITS // MATCH_EVAL_SIMHASH_BANDS
    weights = 1 << np.arange(width)
    bands = np.stack(
        [
            codes[:, b * width : (b + 1) * width] @ weights
            for b in range(MATCH_EVAL_SIMHASH_BANDS)
        ],
        axis=1,
    )
    hits, fractions = [], []
    for q in queries:
        qcode = simhash_codes(phase.encode(q.text)[None, :], SIMHASH_BITS)[0]
        qbands = np.asarray(
            [
                qcode[b * width : (b + 1) * width] @ weights
                for b in range(MATCH_EVAL_SIMHASH_BANDS)
            ]
        )
        mask = (bands == qbands).any(axis=1)
        fractions.append(float(mask.mean()))
        scores = np.where(mask, phase.score(q.text), -np.inf)
        ranking = top_k(scores, seqs, q.self_seq, MATCH_EVAL_TOP_K, position)
        hits.append(any(s in q.targets for s, sc in ranking if sc > -np.inf))
    return statistics.mean(hits), statistics.mean(fractions)


def percentile(values: list[float], p: float) -> float:
    return float(np.percentile(values, p))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir", type=Path)
    args = parser.parse_args()
    seq_list, names, queries = load(args.data_dir)
    seqs = np.asarray(seq_list)
    position = {s: i for i, s in enumerate(seq_list)}
    queries = [q for q in queries if q.targets & position.keys()]
    sources = sorted({q.source for q in queries})
    print(
        f"{len(names)} entity names, {len(queries)} queries: "
        + ", ".join(f"{s} {sum(q.source == s for q in queries)}" for s in sources)
    )

    def rank(scores: NDArray, q: Query) -> Ranking:
        return top_k(scores, seqs, q.self_seq, MATCH_EVAL_TOP_K, position)

    results: dict[str, tuple[list[Ranking], list[float], float | None]] = {}
    for method in ("entity_candidates", "pg_trgm names"):
        results[method] = (
            [q.sql[method] for q in queries],
            [q.sql_ms[method] for q in queries],
            MATCH_EVAL_TRGM_THRESHOLD,
        )

    trigram_index, word_index = (
        Index(names, with_words) for with_words in (False, True)
    )
    results["jaccard"] = (
        *timed(jaccard_scorer(trigram_index), queries, rank),
        MATCH_EVAL_TRGM_THRESHOLD,
    )
    for use_idf in (False, True):
        tag = "idf" if use_idf else "flat"
        results[f"cosine {tag}"] = (
            *timed(cosine_scorer(trigram_index, use_idf), queries, rank),
            None,
        )
    sample = random.Random(MATCH_EVAL_SEED).sample(
        range(len(names)), MATCH_EVAL_SELF_CHECK_NAMES
    )
    best: PhaseIndex | None = None
    for index, d, use_idf in (
        (trigram_index, PHASE_DIM, False),
        (trigram_index, PHASE_DIM, True),
        (word_index, PHASE_DIM, True),
        (trigram_index, PHASE_DIM_LARGE, True),
    ):
        phase = PhaseIndex(index, d, use_idf)
        drift = phase.self_check(sample)
        assert drift < 1e-3, (
            f"numpy encoding drifted from phase_ngrams.encode by {drift}"
        )
        tag = f"phase d={d} {'idf' if use_idf else 'flat'}{' +words' if index.with_words else ''}"
        results[tag] = (*timed(phase.score, queries, rank), None)
        if d == PHASE_DIM and use_idf and not index.with_words:
            best = phase

    baseline = measure(
        queries, results["pg_trgm names"][0], MATCH_EVAL_TRGM_THRESHOLD, 0.0
    )
    coverage = baseline.coverage_at_threshold or 0.0
    print(
        f"\nk = {MATCH_EVAL_TOP_K}; threshold {MATCH_EVAL_TRGM_THRESHOLD}; matched coverage = {coverage:.3f} (pg_trgm names' top-1 at the threshold)\n"
    )
    print(
        "| method | recall@k | MRR@k | "
        + " | ".join(f"recall {s}" for s in sources)
        + " | P@0.3 (coverage) | P@matched coverage | ms p50 | ms p95 |"
    )
    print("|---" * (7 + len(sources)) + "|")
    for method, (rankings, ms, threshold) in results.items():
        m = measure(queries, rankings, threshold, coverage)
        at_t = (
            f"{m.precision_at_threshold:.3f} ({m.coverage_at_threshold:.3f})"
            if m.precision_at_threshold is not None
            else "-"
        )
        print(
            f"| {method} | {m.recall:.3f} | {m.mrr:.3f} | "
            + " | ".join(f"{m.recall_by_source[s]:.3f}" for s in sources)
            + f" | {at_t} | {m.precision_at_matched_coverage:.3f} | {percentile(ms, 50):.2f} | {percentile(ms, 95):.2f} |"
        )
    if best is not None:
        subset = random.Random(MATCH_EVAL_SEED).sample(
            queries, min(MATCH_EVAL_SIMHASH_QUERIES, len(queries))
        )
        recall, fraction = simhash_prefilter(best, subset, seqs, position)
        print(
            f"\nSimHash prefilter ({SIMHASH_BITS} bits, {MATCH_EVAL_SIMHASH_BANDS} bands) on phase d={PHASE_DIM} idf, "
            f"{len(subset)} queries: recall@k {recall:.3f}, {fraction:.1%} of entities ranked per query"
        )


if __name__ == "__main__":
    main()
