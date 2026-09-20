"""Property-based tests: fuzz Combinable's law instead of hand-picking samples.

test_algebra.py checks the law against 2 fixed triples drawn from a fixed
9-word list. Neither is a good fuzz target: fixed examples only cover what
someone thought to write down, and sampling from a fixed word list only
fuzzes *combinations* of those 9 words, not the input space. Here, words
themselves are generated (word_strategy, plain lowercase letters, no fixed
vocabulary anywhere), and bag_of_words_embed's vocab is derived per-example
from whatever words actually appear in x/y/z — so every generated example
gets its own vocabulary, not a shared hardcoded one.

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

word_strategy = st.text(alphabet=st.characters(min_codepoint=ord("a"), max_codepoint=ord("z")), min_size=1, max_size=8)
text_strategy = st.lists(word_strategy, min_size=1, max_size=4).map(" ".join)


def join_with_space(x: str, y: str) -> str:
    return f"{x} {y}"


@given(x=text_strategy, y=text_strategy, z=text_strategy)
def test_bag_of_words_full_law_holds_for_any_generated_sample(x: str, y: str, z: str) -> None:
    vocab = sorted(set(f"{x} {y} {z}".lower().split()))
    combinable = Combinable(
        embed=bag_of_words_embed(vocab),
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
