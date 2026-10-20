"""Algebraic properties of the hashed phase-vector encoding (phase_ngrams.py)."""

from __future__ import annotations

import math
import random
import statistics
import string

from hypothesis import given, settings
from hypothesis import strategies as st
from phase_ngrams import (
    Idf,
    bind,
    bundle,
    encode,
    encode_sequence,
    encode_title,
    hamming,
    norm,
    ordered_bigram,
    permute,
    phasor,
    rope_frequencies,
    rotate,
    set_cosine,
    simhash,
    similarity,
    tokens,
    trigrams,
    unbind,
    weights,
)

D = 256
SD = 1 / math.sqrt(
    2 * D
)  # sd of Re⟨u, v⟩ / D for independent phasors, and of a bundle's error
SAMPLE = 300
SEED = 0

token = st.text(alphabet="abcdefghijklmnopqrstuvwxyz", min_size=1, max_size=6)
name = st.lists(token, min_size=1, max_size=4).map(" ".join)


def close(u: list[complex], v: list[complex], tol: float = 1e-9) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(u, v, strict=True))


def random_tokens(rng: random.Random, n: int) -> list[str]:
    """n distinct lowercase tokens from a fixed seed, so statistical checks are reproducible."""
    out: set[str] = set()
    while len(out) < n:
        out.add("".join(rng.choices(string.ascii_lowercase, k=rng.randint(2, 6))))
    return sorted(out)


def random_names(rng: random.Random, n: int) -> list[str]:
    return [" ".join(random_tokens(rng, rng.randint(1, 4))) for _ in range(n)]


def looks_like_noise(values: list[float], sd: float) -> bool:
    """Mean within 4 standard errors of 0 and sample sd within 25% of sd."""
    mean = statistics.fmean(values)
    return (
        abs(mean) < 4 * sd / math.sqrt(len(values))
        and abs(statistics.pstdev(values) / sd - 1) < 0.25
    )


def test_trigrams_are_pg_trgm_style() -> None:
    assert trigrams("Cat") == {"  c", " ca", "cat", "at "}
    assert trigrams("O\u2019Kane") == trigrams("o'kane") == trigrams("O KANE")


def test_folding_makes_spellings_identical() -> None:
    assert math.isclose(
        similarity(encode("Sean O'Kane", D), encode("Sean O\u2019Kane", D)), 1.0
    )
    assert math.isclose(
        similarity(encode("Musée d'Orsay", D), encode("musee d orsay", D)), 1.0
    )


def test_names_ignore_word_order() -> None:
    assert math.isclose(
        similarity(encode("O'Kane, Sean", D), encode("Sean O'Kane", D)), 1.0
    )


def test_word_tokens_are_namespaced() -> None:
    assert "#cat" in tokens("cat", with_words=True)
    assert "#cat" not in tokens("cat")


@given(token)
def test_phasors_are_unit_and_deterministic(t: str) -> None:
    z = phasor(t, D)
    assert all(math.isclose(abs(x), 1.0) for x in z)
    assert z == phasor(t, D)


@given(name, name)
def test_similarity_is_symmetric_bounded_and_reflexive(a: str, b: str) -> None:
    u, v = encode(a, D), encode(b, D)
    assert math.isclose(similarity(u, u), 1.0)
    assert math.isclose(similarity(u, v), similarity(v, u), abs_tol=1e-12)
    assert -1 - 1e-9 <= similarity(u, v) <= 1 + 1e-9


def test_distinct_tokens_are_nearly_orthogonal() -> None:
    pool = random_tokens(random.Random(SEED), 2 * SAMPLE)
    sims = [
        similarity(phasor(s, D), phasor(t, D)) / D
        for s, t in zip(pool[::2], pool[1::2], strict=True)
    ]
    assert looks_like_noise(sims, SD)


def test_bundle_similarity_estimates_set_cosine() -> None:
    rng = random.Random(SEED)
    errors = []
    for a, b in zip(random_names(rng, SAMPLE), random_names(rng, SAMPLE), strict=True):
        wa, wb = weights(a), weights(b)
        errors.append(similarity(bundle(wa, D), bundle(wb, D)) - set_cosine(wa, wb))
    assert abs(statistics.fmean(errors)) < 4 * SD / math.sqrt(SAMPLE)
    assert math.sqrt(statistics.fmean(e * e for e in errors)) < 1.25 * SD


@given(token, token, token)
def test_bind_is_commutative_associative_and_invertible(a: str, b: str, c: str) -> None:
    x, y, z = phasor(a, D), phasor(b, D), phasor(c, D)
    assert close(bind(x, y), bind(y, x))
    assert close(bind(bind(x, y), z), bind(x, bind(y, z)))
    assert close(unbind(bind(x, y), y), x)


@settings(max_examples=30, deadline=None)
@given(name, name, token)
def test_binding_with_one_key_keeps_similarity(a: str, b: str, key: str) -> None:
    u, v, k = encode(a, D), encode(b, D), phasor(key, D)
    assert math.isclose(
        similarity(bind(u, k), bind(v, k)), similarity(u, v), abs_tol=1e-9
    )


def test_a_bound_pair_is_unlike_its_parts() -> None:
    pool = random_tokens(random.Random(SEED), 2 * SAMPLE)
    pairs = zip(pool[::2], pool[1::2], strict=True)
    sims = [
        similarity(bind(phasor(a, D), phasor(b, D)), phasor(a, D)) / D for a, b in pairs
    ]
    assert looks_like_noise(sims, SD)


@given(token, token)
def test_a_plain_product_commutes_but_ordered_bigram_is_bind_after_permute(
    a: str, b: str
) -> None:
    x, y = phasor(a, D), phasor(b, D)
    assert close(bind(x, y), bind(y, x))
    assert close(ordered_bigram(a, b, D), bind(x, permute(y)))
    assert close(unbind(ordered_bigram(a, b, D), permute(y)), x)


def test_ordered_bigram_tells_the_two_orders_apart() -> None:
    pool = random_tokens(random.Random(SEED), 2 * SAMPLE)
    pairs = zip(pool[::2], pool[1::2], strict=True)
    sims = [
        similarity(ordered_bigram(a, b, D), ordered_bigram(b, a, D)) / D
        for a, b in pairs
    ]
    assert looks_like_noise(sims, SD)


def test_permute_is_a_cyclic_shift() -> None:
    v = [1 + 0j, 2 + 0j, 3 + 0j]
    assert permute(v, 1) == [3, 1, 2]
    assert permute(permute(v, 1), -1) == v
    assert permute(v, 3) == v


@settings(max_examples=30, deadline=None)
@given(st.lists(token, min_size=1, max_size=5), st.integers(min_value=0, max_value=50))
def test_rope_shift_is_a_rotation(seq: list[str], m: int) -> None:
    assert close(
        encode_sequence(seq, D, offset=m), rotate(encode_sequence(seq, D), m), tol=1e-9
    )


@settings(max_examples=30, deadline=None)
@given(name, name, st.integers(min_value=0, max_value=50))
def test_rotation_is_unitary(a: str, b: str, m: int) -> None:
    u, v = encode(a, D), encode(b, D)
    assert math.isclose(norm(rotate(u, m)), 1.0)
    assert math.isclose(
        similarity(rotate(u, m), rotate(v, m)), similarity(u, v), abs_tol=1e-9
    )


def test_rope_swap_costs_what_the_frequencies_predict() -> None:
    # Swapping the ends of a 3-token sequence moves two tokens by 2 positions:
    # E[sim] = (1 + 2 * mean_j cos(2 * omega_j)) / 3. RoPE's geometric spectrum
    # has few fast dimensions, so this stays high; ordered_bigram is the
    # short-range order signal.
    forward = encode_sequence(["apple", "beats", "uber"], D)
    swapped = encode_sequence(["uber", "beats", "apple"], D)
    expected = (1 + 2 * sum(math.cos(2 * w) for w in rope_frequencies(D)) / D) / 3
    assert abs(similarity(forward, swapped) - expected) < 4 * SD
    assert similarity(forward, swapped) < 1 - 1e-3


def test_titles_keep_order_and_names_do_not() -> None:
    a, b = "Apple sues Uber", "Uber sues Apple"
    assert math.isclose(similarity(encode(a, D), encode(b, D)), 1.0)
    assert similarity(encode_title(a, D), encode_title(b, D)) < 0.9
    assert math.isclose(similarity(encode_title(a, D), encode_title(a, D)), 1.0)


def test_simhash_preserves_closeness() -> None:
    same = encode("Drew Pusateri", D)
    assert hamming(simhash(same), simhash(encode("Drew Pusateri", D))) == 0
    near = hamming(simhash(same), simhash(encode("Drew Pusatery", D)))
    far = hamming(simhash(same), simhash(encode("Taiwan Semiconductor", D)))
    assert near < far


def test_idf_lets_a_rare_shared_token_outweigh_a_common_one() -> None:
    corpus = ["Paris Museum", "Paris Opera", "Paris Zoo", "Paris Metro", "Orsay"]
    idf = Idf(corpus)
    assert idf("ors") > idf("par")
    plain = similarity(encode("Paris Orsay", D), encode("Paris Zoo", D))
    weighted = similarity(encode("Paris Orsay", D, idf), encode("Paris Zoo", D, idf))
    assert weighted < plain
