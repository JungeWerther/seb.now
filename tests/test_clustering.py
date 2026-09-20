from functools import reduce
from itertools import product

import pytest

from seb_now.algebra import SampleTriple, bag_of_words_embed, hashed_embed, vec_add, vec_isclose
from seb_now.clustering import IncompatibleEmbeddingError, TopicClusterer

MARKET_WORDS = ["macro", "prices", "rose", "fell"]
SPORTS_WORDS = ["team", "scored", "goal", "win"]
VOCAB = MARKET_WORDS + SPORTS_WORDS

SAMPLES = [
    SampleTriple(x, y, z)
    for x, y, z in product(["macro prices", "team scored"], ["rose fell"], ["goal win"])
]


def test_validate_passes_for_bag_of_words() -> None:
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(VOCAB),
        combine_emb=vec_add,
        is_close=vec_isclose,
    )

    report = clusterer.validate(SAMPLES)

    assert report.holds


def test_validate_fails_for_hashed_embed() -> None:
    clusterer = TopicClusterer(
        embed=hashed_embed(),
        combine_emb=vec_add,
        is_close=vec_isclose,
    )

    report = clusterer.validate(SAMPLES)

    assert not report.holds


def test_require_valid_raises_for_incompatible_embedding() -> None:
    clusterer = TopicClusterer(
        embed=hashed_embed(),
        combine_emb=vec_add,
        is_close=vec_isclose,
    )

    with pytest.raises(IncompatibleEmbeddingError):
        clusterer.require_valid(SAMPLES)


def test_require_valid_passes_silently_for_bag_of_words() -> None:
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(VOCAB),
        combine_emb=vec_add,
        is_close=vec_isclose,
    )

    clusterer.require_valid(SAMPLES)  # must not raise


def test_articles_cluster_by_topic() -> None:
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(VOCAB),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=0.3,
    )
    clusterer.require_valid(SAMPLES)

    market_a = clusterer.add_article("macro prices rose")
    market_b = clusterer.add_article("prices fell")
    sports_a = clusterer.add_article("team scored goal")
    sports_b = clusterer.add_article("team win")

    assert len(clusterer.clusters) == 2
    assert market_a is market_b
    assert sports_a is sports_b
    assert market_a is not sports_a
    assert set(market_a.member_texts) == {"macro prices rose", "prices fell"}
    assert set(sports_a.member_texts) == {"team scored goal", "team win"}


def test_incremental_centroid_matches_batch_sum_regardless_of_order() -> None:
    # similarity_threshold=-1 forces every article into the one cluster that
    # already exists, isolating the fold's associativity from the (separately
    # order-sensitive, by design) threshold-based assignment heuristic.
    embed = bag_of_words_embed(VOCAB)
    texts = ["macro prices rose", "prices fell", "macro rose"]
    vectors = [embed(text) for text in texts]
    batch_sum = reduce(vec_add, vectors)

    forward = TopicClusterer(
        embed=embed, combine_emb=vec_add, is_close=vec_isclose, similarity_threshold=-1.0
    )
    for text in texts:
        forward.add_article(text)

    backward = TopicClusterer(
        embed=embed, combine_emb=vec_add, is_close=vec_isclose, similarity_threshold=-1.0
    )
    for text in reversed(texts):
        backward.add_article(text)

    assert len(forward.clusters) == 1
    assert len(backward.clusters) == 1
    assert vec_isclose(forward.clusters[0].sum_vector, batch_sum)
    assert vec_isclose(backward.clusters[0].sum_vector, batch_sum)
