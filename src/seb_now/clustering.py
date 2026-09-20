"""Group article texts into topic clusters, gated by Combinable's law check.

Each cluster maintains a running sum of its members' embeddings and folds a
new member in via combine_emb as it arrives (TopicCluster.centroid is that
sum's mean). Recomputing a cluster from scratch — re-embed every member,
combine_emb them all — has to give the same sum as the incremental fold
reached one article at a time, in whatever order they arrived. That's
exactly the identity Combinable checks: if it doesn't hold for a given
(embed, combine_emb) pair, TopicClusterer's centroids are order-dependent
and silently wrong. require_valid() (or validate(), for a report instead of
a raise) runs that check before the pair is used for real.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import sqrt
from typing import Sequence

from seb_now.algebra import (
    Combinable,
    CombineEmb,
    Embed,
    IsClose,
    LawReport,
    SampleTriple,
    Vector,
    vec_scale,
)
from seb_now.constants import DEFAULT_SIMILARITY_THRESHOLD


class IncompatibleEmbeddingError(ValueError):
    """Raised when an (embed, combine_emb) pair fails Combinable's law check."""


def cosine_similarity(a: Vector, b: Vector) -> float:
    dot = sum(ai * bi for ai, bi in zip(a, b))
    norm_a = sqrt(sum(ai * ai for ai in a))
    norm_b = sqrt(sum(bi * bi for bi in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


@dataclass
class TopicCluster:
    member_texts: list[str] = field(default_factory=list)
    sum_vector: Vector = ()
    count: int = 0

    @property
    def centroid(self) -> Vector:
        return vec_scale(self.sum_vector, 1.0 / self.count)


@dataclass
class TopicClusterer:
    embed: Embed[Vector]
    combine_emb: CombineEmb[Vector]
    is_close: IsClose[Vector]
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    clusters: list[TopicCluster] = field(default_factory=list)

    def combinable(self) -> Combinable[Vector]:
        return Combinable(
            embed=self.embed,
            combine_text=lambda x, y: f"{x} {y}",
            combine_emb=self.combine_emb,
            is_close=self.is_close,
        )

    def validate(self, samples: Sequence[SampleTriple]) -> LawReport:
        return self.combinable().check(samples)

    def require_valid(self, samples: Sequence[SampleTriple]) -> None:
        report = self.validate(samples)
        if not report.holds:
            raise IncompatibleEmbeddingError(
                f"embed/combine_emb pair fails Combinable's law on {report.total} "
                f"sample(s): {len(report.homomorphism_failures)} homomorphism, "
                f"{len(report.combinator_associativity_failures)} combinator-associativity, "
                f"{len(report.full_law_failures)} full-law failure(s). Incremental "
                "cluster centroids would be order-dependent and silently wrong with "
                "this embedding — pick a compositional embed (e.g. bag_of_words_embed) "
                "or train one (see examples/train_compositional_embedding.py)."
            )

    def add_article(self, text: str) -> TopicCluster:
        vector = self.embed(text)

        best_cluster: TopicCluster | None = None
        best_similarity = self.similarity_threshold
        for cluster in self.clusters:
            similarity = cosine_similarity(vector, cluster.centroid)
            if similarity >= best_similarity:
                best_cluster = cluster
                best_similarity = similarity

        if best_cluster is None:
            best_cluster = TopicCluster()
            self.clusters.append(best_cluster)

        best_cluster.member_texts.append(text)
        best_cluster.sum_vector = (
            self.combine_emb(best_cluster.sum_vector, vector) if best_cluster.count > 0 else vector
        )
        best_cluster.count += 1
        return best_cluster
