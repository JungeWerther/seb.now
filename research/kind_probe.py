"""Linear probe: is an entity's kind linearly readable from its name alone?

Loads every entity's `name` and `kind_path` from `public.entities` (public
read, anon key), then at each depth of the kind tree (`entity.agent`,
`entity.agent.org`, ...) trains a logistic regression on two featurisations
of the bare name:

- `chars`: TF-IDF over character n-grams. No model, so it measures how much
  of the kind is in the surface form ("Inc.", "-ville", capitalisation).
- `embed`: a frozen multilingual sentence embedding. What the probe adds over
  `chars` is what the embedding model knows about the name.

Each probe is reported against the majority class and against a control task
(Hewitt & Liang 2019): every distinct name gets one random kind, and the same
probe is trained and scored on those. Accuracy minus control accuracy is the
probe's selectivity; a probe that only beats the majority by memorising names
has a control close to its own score. Both feature types use the same split,
and the TF-IDF vocabulary is fitted on the training names only.

Source entities (`entity.source.*`) are left out: their kind comes from which
table they were made from, not from anything in the name.

Run with:
    uv run --group research python research/kind_probe.py
    uv run --group research python research/kind_probe.py --skip-embed
"""

from __future__ import annotations

import argparse
import random
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from constants import (
    CHAR_NGRAM_ANALYZER,
    CHAR_NGRAM_LOWERCASE,
    CHAR_NGRAM_MAX,
    CHAR_NGRAM_MIN,
    E5_INPUT_PREFIX,
    KIND_PROBE_C,
    KIND_PROBE_CLASS_WEIGHT,
    KIND_PROBE_EMBED_BATCH,
    KIND_PROBE_EXCLUDED_ROOT,
    KIND_PROBE_MAX_ITER,
    KIND_PROBE_MIN_EXAMPLES,
    KIND_PROBE_PAGE_SIZE,
    KIND_PROBE_SEED,
    KIND_PROBE_TEST_FRACTION,
    KIND_PROBE_TOP_CONFUSIONS,
    ModelName,
)

if TYPE_CHECKING:
    from numpy.typing import NDArray


@dataclass(frozen=True)
class Entity:
    name: str
    kind_path: str


@dataclass(frozen=True)
class ProbeResult:
    depth: int
    features: str
    classes: int
    train: int
    test: int
    majority: float
    accuracy: float
    control: float
    confusions: list[tuple[str, str, int]]

    @property
    def selectivity(self) -> float:
        return self.accuracy - self.control


def kind_at_depth(kind_path: str, depth: int) -> str | None:
    """The kind_path cut to `depth` levels below the root, or None if it's shallower."""
    parts = kind_path.split(".")
    return ".".join(parts[: depth + 1]) if len(parts) > depth else None


def labelled_at_depth(entities: list[Entity], depth: int, min_examples: int) -> tuple[list[str], list[str]]:
    """Names and their kind at `depth`, keeping kinds with at least `min_examples` names."""
    pairs = [(e.name, k) for e in entities if (k := kind_at_depth(e.kind_path, depth)) is not None]
    counts = Counter(k for _, k in pairs)
    kept = [(n, k) for n, k in pairs if counts[k] >= min_examples]
    return [n for n, _ in kept], [k for _, k in kept]


def load_entities() -> list[Entity]:
    from seb_now.auth import get_unauthenticated_client

    client = get_unauthenticated_client()
    entities: list[Entity] = []
    start = 0
    while True:
        rows = (
            client.table("entities")
            .select("name, kind_path")
            .order("id")
            .range(start, start + KIND_PROBE_PAGE_SIZE - 1)
            .execute()
            .data
        )
        entities += [
            Entity(r["name"], r["kind_path"])
            for r in rows
            if r["name"] and r["kind_path"] and not r["kind_path"].startswith(KIND_PROBE_EXCLUDED_ROOT)
        ]
        if len(rows) < KIND_PROBE_PAGE_SIZE:
            return entities
        start += KIND_PROBE_PAGE_SIZE


Featurize = Callable[[list[str], list[str]], tuple["NDArray", "NDArray"]]


def char_features(train_names: list[str], test_names: list[str]) -> tuple[NDArray, NDArray]:
    """TF-IDF over character n-grams, its vocabulary and weights fitted on the training names only."""
    from sklearn.feature_extraction.text import TfidfVectorizer

    vectorizer = TfidfVectorizer(
        analyzer=CHAR_NGRAM_ANALYZER,
        ngram_range=(CHAR_NGRAM_MIN, CHAR_NGRAM_MAX),
        lowercase=CHAR_NGRAM_LOWERCASE,
    )
    return vectorizer.fit_transform(train_names), vectorizer.transform(test_names)


def embed_names(names: list[str]) -> dict[str, NDArray]:
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(ModelName.MULTILINGUAL_E5_SMALL)
    vectors = model.encode(
        [E5_INPUT_PREFIX + n for n in names],
        batch_size=KIND_PROBE_EMBED_BATCH,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    return dict(zip(names, vectors))


def lookup_features(embeddings: dict[str, NDArray]) -> Featurize:
    import numpy as np

    def featurize(train_names: list[str], test_names: list[str]) -> tuple[NDArray, NDArray]:
        return np.stack([embeddings[n] for n in train_names]), np.stack([embeddings[n] for n in test_names])

    return featurize


def control_labels(names: list[str], labels: list[str], seed: int) -> list[str]:
    """Hewitt & Liang's control task: one random kind per distinct name, drawn
    from the kinds' own frequencies, the same for every occurrence of the name."""
    distinct = sorted(set(names))
    drawn = random.Random(seed).choices(labels, k=len(distinct))
    by_name = dict(zip(distinct, drawn))
    return [by_name[n] for n in names]


def fit_score(x_train: NDArray, y_train: list[str], x_test: NDArray, y_test: list[str]) -> tuple[float, list[str]]:
    import numpy as np
    from sklearn.linear_model import LogisticRegression

    probe = LogisticRegression(C=KIND_PROBE_C, max_iter=KIND_PROBE_MAX_ITER, class_weight=KIND_PROBE_CLASS_WEIGHT)
    probe.fit(x_train, y_train)
    predicted = list(probe.predict(x_test))
    return float(np.mean([p == t for p, t in zip(predicted, y_test)])), predicted


def probe(names: list[str], labels: list[str], featurize: Featurize, depth: int, feature_name: str) -> ProbeResult:
    import numpy as np
    from sklearn.model_selection import train_test_split

    train_idx, test_idx = train_test_split(
        np.arange(len(labels)), test_size=KIND_PROBE_TEST_FRACTION, random_state=KIND_PROBE_SEED, stratify=labels
    )
    x_train, x_test = featurize([names[i] for i in train_idx], [names[i] for i in test_idx])
    y_train = [labels[i] for i in train_idx]
    y_test = [labels[i] for i in test_idx]
    accuracy, predicted = fit_score(x_train, y_train, x_test, y_test)

    controls = control_labels(names, labels, KIND_PROBE_SEED)
    control, _ = fit_score(x_train, [controls[i] for i in train_idx], x_test, [controls[i] for i in test_idx])

    majority = Counter(y_train).most_common(1)[0][0]
    confusions = Counter((t, p) for t, p in zip(y_test, predicted) if t != p)
    return ProbeResult(
        depth=depth,
        features=feature_name,
        classes=len(set(labels)),
        train=len(train_idx),
        test=len(test_idx),
        majority=float(np.mean([t == majority for t in y_test])),
        accuracy=accuracy,
        control=control,
        confusions=[(t, p, n) for (t, p), n in confusions.most_common(KIND_PROBE_TOP_CONFUSIONS)],
    )


def report(results: list[ProbeResult]) -> None:
    print(
        f"\n{'depth':>5} {'features':>8} {'classes':>7} {'test':>6} {'majority':>8} {'probe':>6} {'control':>7} {'select.':>7}"
    )
    for r in results:
        print(
            f"{r.depth:>5} {r.features:>8} {r.classes:>7} {r.test:>6} "
            f"{r.majority:>8.3f} {r.accuracy:>6.3f} {r.control:>7.3f} {r.selectivity:>7.3f}"
        )
    for r in results:
        if r.confusions:
            print(f"\ndepth {r.depth}, {r.features}: most common mistakes (true → predicted)")
            for true, predicted, n in r.confusions:
                print(f"  {n:>5}  {true} → {predicted}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--skip-embed", action="store_true", help="only the character n-gram probe (no model download)")
    args = parser.parse_args()

    entities = load_entities()
    print(f"{len(entities)} entities (excluding {KIND_PROBE_EXCLUDED_ROOT}*)")
    max_depth = max(len(e.kind_path.split(".")) for e in entities) - 1

    embed = None if args.skip_embed else lookup_features(embed_names(sorted({e.name for e in entities})))

    results: list[ProbeResult] = []
    for depth in range(1, max_depth + 1):
        names, labels = labelled_at_depth(entities, depth, KIND_PROBE_MIN_EXAMPLES)
        if len(set(labels)) < 2:
            continue
        results.append(probe(names, labels, char_features, depth, "chars"))
        if embed:
            results.append(probe(names, labels, embed, depth, "embed"))
    report(results)


if __name__ == "__main__":
    main()
