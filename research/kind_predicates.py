"""Kind predicates: one independent yes/no probe per kind ("is it an org?").

Unlike kind_probe.py's single softmax, each predicate is its own logistic
regression, so a name can be several kinds at once (MeTTa-style: one term,
several senses). Targets are multi-label too: since names are unique per
kind, the same name can sit under several kind_paths, and all of them count.

Per predicate: ROC AUC on held-out names, and the same probe on Hewitt &
Liang control labels. Then over the test names: how often more than one
predicate fires, and on names that really carry several kinds, how often
the predicates recover all of them.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import numpy as np
from constants import (
    KIND_PREDICATE_THRESHOLD,
    KIND_PREDICATE_TOP_COMBOS,
    KIND_PROBE_C,
    KIND_PROBE_CLASS_WEIGHT,
    KIND_PROBE_MAX_ITER,
    KIND_PROBE_MIN_EXAMPLES,
    KIND_PROBE_SEED,
    KIND_PROBE_TEST_FRACTION,
)
from kind_probe import Entity, embed_names, kind_at_depth, load_entities
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split


@dataclass(frozen=True)
class Predicate:
    kind: str
    positives: int
    auc: float
    control_auc: float


def kinds_by_name(entities: list[Entity], depth: int) -> dict[str, frozenset[str]]:
    senses: dict[str, set[str]] = defaultdict(set)
    for e in entities:
        if (k := kind_at_depth(e.kind_path, depth)) is not None:
            senses[e.name].add(k)
    return {n: frozenset(ks) for n, ks in senses.items()}


def fit(x_train: np.ndarray, y_train: np.ndarray, x_test: np.ndarray) -> np.ndarray:
    model = LogisticRegression(C=KIND_PROBE_C, max_iter=KIND_PROBE_MAX_ITER, class_weight=KIND_PROBE_CLASS_WEIGHT)
    return model.fit(x_train, y_train).predict_proba(x_test)[:, 1]


def run_depth(entities: list[Entity], embed: dict[str, np.ndarray], depth: int) -> None:
    senses = kinds_by_name(entities, depth)
    counts = defaultdict(int)
    for ks in senses.values():
        for k in ks:
            counts[k] += 1
    kinds = sorted(k for k, c in counts.items() if c >= KIND_PROBE_MIN_EXAMPLES)
    if len(kinds) < 2:
        return
    names = sorted(n for n, ks in senses.items() if ks & set(kinds))
    y = np.array([[k in senses[n] for k in kinds] for n in names])
    x = np.stack([embed[n] for n in names])
    tr, te = train_test_split(np.arange(len(names)), test_size=KIND_PROBE_TEST_FRACTION, random_state=KIND_PROBE_SEED)
    rng = np.random.default_rng(KIND_PROBE_SEED)
    y_control = y[rng.permutation(len(names))]  # each name gets another name's kinds: same label marginals, no signal

    def two_classes(j: int) -> bool:
        """Both yes and no in every train/test target, real and control, so fit and AUC are defined."""
        return all(len(np.unique(t[idx, j])) == 2 for t in (y, y_control) for idx in (tr, te))

    supported = [j for j in range(len(kinds)) if two_classes(j)]
    skipped = [kinds[j] for j in range(len(kinds)) if j not in supported]
    if skipped:
        print(f"\ndepth {depth}: skipping predicates with one class in a split: {', '.join(skipped)}")
    if not supported:
        return
    kinds = [kinds[j] for j in supported]
    y, y_control = y[:, supported], y_control[:, supported]

    preds, probs = [], []
    for j, kind in enumerate(kinds):
        p = fit(x[tr], y[tr, j], x[te])
        pc = fit(x[tr], y_control[tr, j], x[te])
        probs.append(p)
        preds.append(
            Predicate(kind, int(y[:, j].sum()), roc_auc_score(y[te, j], p), roc_auc_score(y_control[te, j], pc))
        )
    fired = np.stack(probs, axis=1) >= KIND_PREDICATE_THRESHOLD
    truth = y[te]

    print(f"\n== depth {depth}: {len(names)} names, {len(te)} test ==")
    print(f"{'predicate':<34} {'pos':>6} {'AUC':>6} {'ctrl':>6}")
    for p in preds:
        print(f"{p.kind:<34} {p.positives:>6} {p.auc:>6.3f} {p.control_auc:>6.3f}")
    multi_true = truth.sum(1) > 1
    print(f"names with >1 true kind: {multi_true.sum()} ({multi_true.mean():.1%})")
    print(f"names with >1 predicate firing: {(fired.sum(1) > 1).sum()} ({(fired.sum(1) > 1).mean():.1%})")
    print(f"no predicate firing: {(fired.sum(1) == 0).mean():.1%}")
    if multi_true.any():
        recovered = (fired[multi_true] >= truth[multi_true]).all(1).mean()
        print(f"multi-kind names with all their kinds recovered: {recovered:.1%}")
    exact = (fired == truth).all(1).mean()
    print(f"exact set match: {exact:.1%}")
    combos = defaultdict(int)
    for row in fired:
        if row.sum() > 1:
            combos[" + ".join(k.split(".")[-1] for k, f in zip(kinds, row) if f)] += 1
    for combo, n in sorted(combos.items(), key=lambda kv: -kv[1])[:KIND_PREDICATE_TOP_COMBOS]:
        print(f"  fires together: {combo:<40} {n}")


def main() -> None:
    entities = load_entities()
    embed = embed_names(sorted({e.name for e in entities}))
    max_depth = max(len(e.kind_path.split(".")) for e in entities) - 1
    for depth in range(1, max_depth + 1):
        run_depth(entities, embed, depth)


if __name__ == "__main__":
    main()
