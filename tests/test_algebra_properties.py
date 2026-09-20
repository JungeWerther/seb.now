"""Property-based tests: fuzz Combinable's law instead of hand-picking samples.

test_algebra.py checks the law against 2 fixed triples chosen by hand.
Hypothesis generates many more — including ones nobody would think to pick,
like single-word texts or texts sharing no vocabulary — which is the actual
QuickCheck-style guarantee: the law holds for the *space* of inputs, not
just the couple of examples someone happened to write down.

bag_of_words_embed is expected to satisfy the law for everything Hypothesis
generates. hashed_embed is expected to violate it — xfail(strict=True)
turns "this unexpectedly stopped failing" into a hard error, so if
hashed_embed's scheme ever changed to become accidentally homomorphic,
that would be caught rather than silently passing.
"""

from __future__ import annotations

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from seb_now.algebra import Combinable, bag_of_words_embed, hashed_embed, vec_add, vec_isclose

WORDS = ["macro", "prices", "rose", "fell", "today", "team", "scored", "goal", "win"]

text_strategy = st.lists(st.sampled_from(WORDS), min_size=1, max_size=4).map(" ".join)


def join_with_space(x: str, y: str) -> str:
    return f"{x} {y}"


@given(x=text_strategy, y=text_strategy, z=text_strategy)
def test_bag_of_words_full_law_holds_for_any_generated_sample(x: str, y: str, z: str) -> None:
    combinable = Combinable(
        embed=bag_of_words_embed(WORDS),
        combine_text=join_with_space,
        combine_emb=vec_add,
        is_close=vec_isclose,
    )
    assert combinable.full_law_holds(x, y, z)


@pytest.mark.xfail(strict=True, reason="hashed_embed is not a homomorphism; expected to fail")
@given(x=text_strategy, y=text_strategy, z=text_strategy)
@example(x="macro", y="prices", z="rose")
def test_hashed_embed_violates_the_full_law(x: str, y: str, z: str) -> None:
    combinable = Combinable(
        embed=hashed_embed(),
        combine_text=join_with_space,
        combine_emb=vec_add,
        is_close=vec_isclose,
    )
    assert combinable.full_law_holds(x, y, z)
