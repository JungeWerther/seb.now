"""Checking, not assuming, that a text embedding is compositional.

Given a way to combine two texts (``combine_text``) and a way to combine two
embeddings (``combine_emb``), the identity we actually want is

    embed(combine_text(combine_text(x, y), z)) == combine_emb(combine_emb(embed(x), embed(y)), embed(z))
                                                == combine_emb(embed(x), combine_emb(embed(y), embed(z)))

This only holds when three independent things are all true at once: the text
operation is associative, ``embed`` is a homomorphism onto ``combine_emb``
(no cross-term leaks between the pieces), and ``combine_emb`` is itself
associative. A `Combinable` doesn't assume any of that — it runs samples
through each sub-check separately so a failure points at which precondition
broke, plus the composite `full_law_holds` for the identity itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Generic, NamedTuple, Sequence, TypeVar

V = TypeVar("V")

Embed = Callable[[str], V]
CombineText = Callable[[str, str], str]
CombineEmb = Callable[[V, V], V]
IsClose = Callable[[V, V], bool]


class SamplePair(NamedTuple):
    x: str
    y: str


class SampleTriple(NamedTuple):
    x: str
    y: str
    z: str


@dataclass(frozen=True)
class LawReport:
    total: int
    source_associativity_failures: list[SampleTriple] = field(default_factory=list)
    homomorphism_failures: list[SamplePair] = field(default_factory=list)
    combinator_associativity_failures: list[SampleTriple] = field(default_factory=list)
    full_law_failures: list[SampleTriple] = field(default_factory=list)

    @property
    def holds(self) -> bool:
        return self.total > 0 and not (
            self.source_associativity_failures
            or self.homomorphism_failures
            or self.combinator_associativity_failures
            or self.full_law_failures
        )


@dataclass(frozen=True)
class Combinable(Generic[V]):
    embed: Embed[V]
    combine_text: CombineText
    combine_emb: CombineEmb[V]
    is_close: IsClose[V]

    def is_source_associative(self, x: str, y: str, z: str) -> bool:
        left = self.combine_text(self.combine_text(x, y), z)
        right = self.combine_text(x, self.combine_text(y, z))
        return self.is_close(self.embed(left), self.embed(right))

    def is_homomorphism(self, x: str, y: str) -> bool:
        lhs = self.embed(self.combine_text(x, y))
        rhs = self.combine_emb(self.embed(x), self.embed(y))
        return self.is_close(lhs, rhs)

    def is_combinator_associative(self, x: str, y: str, z: str) -> bool:
        ex, ey, ez = self.embed(x), self.embed(y), self.embed(z)
        left = self.combine_emb(self.combine_emb(ex, ey), ez)
        right = self.combine_emb(ex, self.combine_emb(ey, ez))
        return self.is_close(left, right)

    def full_law_holds(self, x: str, y: str, z: str) -> bool:
        combined_text = self.combine_text(self.combine_text(x, y), z)
        predicted = self.combine_emb(self.combine_emb(self.embed(x), self.embed(y)), self.embed(z))
        return self.is_close(self.embed(combined_text), predicted)

    def check(self, samples: Sequence[SampleTriple]) -> LawReport:
        report = LawReport(total=len(samples))
        for x, y, z in samples:
            if not self.is_source_associative(x, y, z):
                report.source_associativity_failures.append(SampleTriple(x, y, z))
            if not self.is_homomorphism(x, y):
                report.homomorphism_failures.append(SamplePair(x, y))
            if not self.is_combinator_associative(x, y, z):
                report.combinator_associativity_failures.append(SampleTriple(x, y, z))
            if not self.full_law_holds(x, y, z):
                report.full_law_failures.append(SampleTriple(x, y, z))
        return report


Vector = tuple[float, ...]


def vec_add(a: Vector, b: Vector) -> Vector:
    return tuple(ai + bi for ai, bi in zip(a, b))


def vec_isclose(a: Vector, b: Vector, tol: float = 1e-9) -> bool:
    return len(a) == len(b) and all(abs(ai - bi) <= tol for ai, bi in zip(a, b))


def vec_scale(v: Vector, factor: float) -> Vector:
    return tuple(vi * factor for vi in v)


def bag_of_words_embed(vocab: Sequence[str]) -> Embed[Vector]:
    """A genuinely compositional embedding: word counts over a fixed vocab.

    Concatenating two texts (joined by whitespace) sums their word counts, so
    this satisfies the homomorphism condition against `vec_add` by construction.
    """

    def embed(text: str) -> Vector:
        words = text.lower().split()
        return tuple(float(words.count(term)) for term in vocab)

    return embed


def hashed_embed(dim: int = 1, modulus: int = 1000) -> Embed[Vector]:
    """A stand-in for a contextual embedding: hashes the whole string at once.

    Because the hash mixes every character together, `embed(x + y)` bears no
    fixed relationship to `embed(x)` and `embed(y)` individually — it fails
    the homomorphism condition against any `combine_emb`, `vec_add` included.
    """

    def embed(text: str) -> Vector:
        return tuple(float((hash(text) >> (8 * i)) % modulus) for i in range(dim))

    return embed
