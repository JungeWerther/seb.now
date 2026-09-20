"""Minimal, runnable demo of TopicClusterer on a handful of headlines.

No heavy deps — bag_of_words_embed is dependency-free, so this runs under
a plain `uv run`, unlike the "examples" dependency group scripts.

Run with:
    uv run python examples/cluster_articles.py
"""

from __future__ import annotations

from seb_now.algebra import SampleTriple, bag_of_words_embed, vec_add, vec_isclose
from seb_now.clustering import TopicClusterer

VOCAB = [
    "fed", "rate", "inflation", "market", "stocks",
    "election", "vote", "poll", "candidate", "ballot",
]

HEADLINES = [
    "Fed signals rate cut as inflation cools",
    "Stocks rally after inflation data beats forecasts",
    "Market watches fed for next rate decision",
    "Candidate leads poll ahead of election",
    "Election officials report record ballot turnout",
    "Vote count tightens in key swing state",
]


def main() -> None:
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(VOCAB),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=0.2,
    )

    validation_samples = [
        SampleTriple(HEADLINES[0], HEADLINES[1], HEADLINES[2]),
        SampleTriple(HEADLINES[3], HEADLINES[4], HEADLINES[5]),
    ]
    clusterer.require_valid(validation_samples)
    print("embedding validated against Combinable's law — safe to cluster incrementally\n")

    for headline in HEADLINES:
        cluster = clusterer.add_article(headline)
        cluster_id = clusterer.clusters.index(cluster)
        print(f"[cluster {cluster_id}] {headline}")

    print()
    for i, cluster in enumerate(clusterer.clusters):
        print(f"cluster {i} centroid: {tuple(round(v, 2) for v in cluster.centroid)}")


if __name__ == "__main__":
    main()
