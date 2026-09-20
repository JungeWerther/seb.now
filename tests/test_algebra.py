from itertools import product

from seb_now.algebra import (
    Combinable,
    LawCheckKind,
    SampleTriple,
    bag_of_words_embed,
    hashed_embed,
    vec_add,
    vec_isclose,
)

WORDS = ["macro", "prices", "rose", "fell", "today"]


def join_with_space(x: str, y: str) -> str:
    return f"{x} {y}"


SAMPLES = [
    SampleTriple(x, y, z)
    for x, y, z in product(["macro prices", "rose today"], ["fell today"], ["macro rose"])
]


def test_bag_of_words_is_a_homomorphism_and_satisfies_the_full_law() -> None:
    combinable = Combinable(
        embed=bag_of_words_embed(WORDS),
        combine_text=join_with_space,
        combine_emb=vec_add,
        is_close=vec_isclose,
    )

    report = combinable.check(SAMPLES)

    assert report.holds
    assert report.failures(LawCheckKind.SOURCE_ASSOCIATIVITY) == []
    assert report.failures(LawCheckKind.HOMOMORPHISM) == []
    assert report.failures(LawCheckKind.COMBINATOR_ASSOCIATIVITY) == []
    assert report.failures(LawCheckKind.FULL_LAW) == []


def test_hashed_embedding_fails_the_homomorphism_condition() -> None:
    combinable = Combinable(
        embed=hashed_embed(),
        combine_text=join_with_space,
        combine_emb=vec_add,
        is_close=vec_isclose,
    )

    report = combinable.check(SAMPLES)

    assert not report.holds
    # vec_add is still associative on its own, and text concatenation is
    # still associative — only the embed-to-combine_emb relationship breaks.
    assert report.failures(LawCheckKind.COMBINATOR_ASSOCIATIVITY) == []
    assert report.failures(LawCheckKind.HOMOMORPHISM) != []
    assert report.failures(LawCheckKind.FULL_LAW) != []
