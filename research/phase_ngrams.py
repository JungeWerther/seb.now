"""Hashed phase vectors over folded, padded character trigrams (SEB-9).

A text becomes a point near the torus (S^1)^d instead of one angle on a
single circle:

1. Tokenize. Fold the text (lowercase, accents stripped, ’ → ') and split it
   into words at every non-alphanumeric character, as pg_trgm does. Each word
   is padded "  word " and cut into trigrams; whole words can be added as
   tokens of their own ("#word").
2. Place each token on d circles. Its d phases are read from the token's
   SHAKE-256 digest, so there is no vocabulary table and nothing overflows.
3. Bundle. v(s) = Σ_t w_t e^{iθ_t}, normalised, with w_t an IDF weight (or 1).
4. Compare. sim(u, v) = Re⟨u, v⟩. For random phases E[e^{i(θ_s − θ_t)}] = 0
   when s ≠ t, so this estimates the weighted cosine of the two token sets,
   with noise of order 1/sqrt(d) (random Fourier features).

The algebra (Plate's Fourier Holographic Reduced Representation):

- `bind` is elementwise multiplication: phases add, the inverse is the
  conjugate, and binding both sides with one key keeps their similarity.
  Binding commutes, so a product of tokens is a bag: e^{iθ_a}·e^{iθ_b}·e^{iω}
  is the same for "a b" and "b a".
- `ordered_bigram` keeps order by permuting the second token's coordinates
  before binding (a ⊙ Πb ≠ b ⊙ Πa).
- `rotate` / `encode_sequence` are RoPE: token k is turned by e^{iωk}, so
  shifting a sequence by m positions turns its vector by e^{iωm}, a unitary
  map that leaves similarities between equally shifted sequences unchanged.
- `simhash` takes the signs of random projections of (Re v, Im v), bits whose
  Hamming distance estimates the angle between two vectors (LSH buckets).

Names should be encoded without order ("O'Kane, Sean" is "Sean O'Kane");
titles can add ordered word bigrams with `encode_title`.

This module is plain Python so its tests run without numpy;
phase_ngrams_eval.py builds the same vectors with numpy for speed and checks
them against `encode`.
"""

from __future__ import annotations

import cmath
import hashlib
import math
import re
import struct
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from itertools import pairwise

from constants import (
    IDF_SMOOTHING,
    PHASE_DIM,
    PHASE_QUANTUM_BITS,
    ROPE_BASE,
    SIMHASH_BITS,
)

Vector = list[complex]

TOKEN_SEED_PREFIX = "tok:"
PLANE_SEED_PREFIX = "plane:"
WORD_TOKEN_PREFIX = "#"
QUANTUM_BYTES = PHASE_QUANTUM_BITS // 8
TURN_PER_QUANTUM = 2 * math.pi / (1 << PHASE_QUANTUM_BITS)
WORD_SPLIT = re.compile(r"[\W_]+")


def fold(text: str) -> str:
    """Lowercase, strip accents and curly apostrophes, like the DB's fold_text."""
    decomposed = unicodedata.normalize("NFKD", text.lower().replace("\u2019", "'"))
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def words(text: str) -> list[str]:
    return [w for w in WORD_SPLIT.split(fold(text)) if w]


def trigrams(text: str) -> set[str]:
    """pg_trgm's trigrams of the folded text: each word padded "  w " and cut in threes."""
    out: set[str] = set()
    for word in words(text):
        padded = f"  {word} "
        out.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return out


def tokens(text: str, with_words: bool = False) -> set[str]:
    out = trigrams(text)
    if with_words:
        out.update(WORD_TOKEN_PREFIX + w for w in words(text))
    return out


def phase_digest(seed: str, d: int) -> bytes:
    return hashlib.shake_256(seed.encode()).digest(QUANTUM_BYTES * d)


def phases(token: str, d: int = PHASE_DIM) -> tuple[float, ...]:
    quanta = struct.unpack(f"<{d}H", phase_digest(TOKEN_SEED_PREFIX + token, d))
    return tuple(q * TURN_PER_QUANTUM for q in quanta)


def phasor(token: str, d: int = PHASE_DIM) -> Vector:
    return [cmath.exp(1j * theta) for theta in phases(token, d)]


def norm(v: Sequence[complex]) -> float:
    return math.sqrt(sum(abs(x) ** 2 for x in v))


def normalise(v: Sequence[complex]) -> Vector:
    n = norm(v)
    return [x / n for x in v] if n else list(v)


def bundle(weighted: Mapping[str, float], d: int = PHASE_DIM) -> Vector:
    """Σ_t w_t e^{iθ_t}, normalised; the zero vector for no tokens."""
    total = [0j] * d
    for token, weight in weighted.items():
        for j, z in enumerate(phasor(token, d)):
            total[j] += weight * z
    return normalise(total)


def similarity(u: Sequence[complex], v: Sequence[complex]) -> float:
    """Re⟨u, v⟩ = Re Σ conj(u_j) v_j."""
    return sum((a.conjugate() * b).real for a, b in zip(u, v, strict=True))


def bind(u: Sequence[complex], v: Sequence[complex]) -> Vector:
    return [a * b for a, b in zip(u, v, strict=True)]


def unbind(u: Sequence[complex], key: Sequence[complex]) -> Vector:
    """Inverse of bind for a unit-modulus key: unbind(bind(u, k), k) = u."""
    return [a * b.conjugate() for a, b in zip(u, key, strict=True)]


def permute(v: Sequence[complex], shift: int = 1) -> Vector:
    shift %= len(v)
    return list(v[-shift:]) + list(v[:-shift]) if shift else list(v)


def ordered_bigram(first: str, second: str, d: int = PHASE_DIM) -> Vector:
    return bind(phasor(first, d), permute(phasor(second, d)))


def rope_frequencies(d: int = PHASE_DIM, base: float = ROPE_BASE) -> list[float]:
    return [base ** (-j / d) for j in range(d)]


def rotate(v: Sequence[complex], position: float, base: float = ROPE_BASE) -> Vector:
    return [x * cmath.exp(1j * omega * position) for x, omega in zip(v, rope_frequencies(len(v), base), strict=True)]


def encode_sequence(sequence: Sequence[str], d: int = PHASE_DIM, offset: int = 0) -> Vector:
    """RoPE-style: Σ_k e^{iω(k + offset)} ⊙ e^{iθ_{t_k}}, normalised."""
    total = [0j] * d
    for k, token in enumerate(sequence):
        for j, z in enumerate(rotate(phasor(token, d), k + offset)):
            total[j] += z
    return normalise(total)


class Idf:
    """Smoothed inverse document frequency over a corpus of texts' token sets."""

    def __init__(self, texts: Iterable[str], with_words: bool = False) -> None:
        self.with_words = with_words
        self.df: Counter[str] = Counter()
        self.n = 0
        for text in texts:
            self.df.update(tokens(text, with_words))
            self.n += 1

    def __call__(self, token: str) -> float:
        return math.log((self.n + IDF_SMOOTHING) / (self.df[token] + IDF_SMOOTHING)) + 1


def weights(text: str, idf: Callable[[str], float] | None = None, with_words: bool = False) -> dict[str, float]:
    return {t: idf(t) if idf else 1.0 for t in tokens(text, with_words)}


def encode(
    text: str,
    d: int = PHASE_DIM,
    idf: Callable[[str], float] | None = None,
    with_words: bool = False,
) -> Vector:
    return bundle(weights(text, idf, with_words), d)


def encode_title(title: str, d: int = PHASE_DIM, idf: Callable[[str], float] | None = None) -> Vector:
    """A title's bag of trigrams plus, with equal weight, its ordered word bigrams."""
    title_words = words(title)
    pairs = [0j] * d
    for first, second in pairwise(title_words):
        pairs = [a + b for a, b in zip(pairs, ordered_bigram(first, second, d), strict=True)]
    bag = encode(title, d, idf)
    return normalise([a + b for a, b in zip(bag, normalise(pairs), strict=True)])


def set_cosine(a: Mapping[str, float], b: Mapping[str, float]) -> float:
    """The exact weighted cosine that `similarity` of two bundles estimates."""
    dot = sum(w * b[t] for t, w in a.items() if t in b)
    na, nb = (
        math.sqrt(sum(w * w for w in a.values())),
        math.sqrt(sum(w * w for w in b.values())),
    )
    return dot / (na * nb) if na and nb else 0.0


def plane(index: int, d: int) -> list[float]:
    """A random direction in R^{2d}, coordinates uniform in [-1, 1)."""
    quanta = struct.unpack(f"<{2 * d}H", phase_digest(f"{PLANE_SEED_PREFIX}{index}", 2 * d))
    return [q / (1 << (PHASE_QUANTUM_BITS - 1)) - 1 for q in quanta]


def simhash(v: Sequence[complex], bits: int = SIMHASH_BITS) -> int:
    real = [x.real for x in v] + [x.imag for x in v]
    out = 0
    for i in range(bits):
        if sum(a * b for a, b in zip(real, plane(i, len(v)), strict=True)) >= 0:
            out |= 1 << i
    return out


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()
