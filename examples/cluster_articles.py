"""Minimal, runnable demo of TopicClusterer on a handful of headlines.

No heavy deps — bag_of_words_embed is dependency-free, so this runs under
a plain `uv run`, unlike the "examples" dependency group scripts.

Run with:
    uv run python examples/cluster_articles.py
"""

from __future__ import annotations

import json
from pathlib import Path

from seb_now.algebra import SampleTriple, bag_of_words_embed, vec_add, vec_isclose
from seb_now.clustering import TopicClusterer
from seb_now.constants import BAG_OF_WORDS_SIMILARITY_THRESHOLD

DATA_DIR = Path(__file__).parent / "data"


def main() -> None:
    vocab: list[str] = json.loads((DATA_DIR / "bag_of_words_vocab.json").read_text())
    headlines: list[str] = json.loads((DATA_DIR / "headlines.json").read_text())

    clusterer = TopicClusterer(
        embed=bag_of_words_embed(vocab),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=BAG_OF_WORDS_SIMILARITY_THRESHOLD,
    )

    validation_samples = [
        SampleTriple(headlines[0], headlines[1], headlines[2]),
        SampleTriple(headlines[3], headlines[4], headlines[5]),
    ]
    clusterer.require_valid(validation_samples)
    print("embedding validated against Combinable's law — safe to cluster incrementally\n")

    for headline in headlines:
        cluster = clusterer.add_article(headline)
        cluster_id = clusterer.clusters.index(cluster)
        print(f"[cluster {cluster_id}] {headline}")

    print()
    for i, cluster in enumerate(clusterer.clusters):
        print(f"cluster {i} centroid: {tuple(round(v, 2) for v in cluster.centroid)}")


if __name__ == "__main__":
    main()
