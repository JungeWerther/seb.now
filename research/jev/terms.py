"""Term-logic relations judged by Jev, emitted as PLN links and MeTTa.

Extension (per pair A, B) - one request, three questions per pair:
  extension        which set relation holds (exclusive and exhaustive, so one Choice)
  a_in_b / b_in_a  graded share of A's instances that are B (and back)

Intension (per term) - the intension of a term is its set of properties. Jev judges one
Noul per (term, property) over a shared candidate property list; code computes the
overlaps. Asking Jev for "the share of B's properties A has" directly fails: it has to
imagine an unlisted set and count it, and its confidence collapses.

Extensional strengths are the expected P(B|A) under Jev's distribution over relations,
e.g. s(Subset A B) = Σ_r P(r) · P(B|A given r), so doubt about which relation holds
lowers the strength instead of being dropped.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import BaseModel, Field

from jev_fill import DescribedIntEnum, DescribedStrEnum, Filled, JevForm

MEMBER_MIN_STRENGTH = 0.05


class Extension(DescribedStrEnum):
    SAME_REFERENCE = (
        "same_reference",
        "A and B pick out exactly the same thing or things: the same individual, or two names "
        "for the same class.",
    )
    A_MEMBER_OF_B = (
        "a_member_of_b",
        "A is one single individual, and it is one of the things B covers.",
    )
    B_MEMBER_OF_A = (
        "b_member_of_a",
        "B is one single individual, and it is one of the things A covers.",
    )
    A_INHERITS_B = (
        "a_inherits_b",
        "A is a kind of B: every A is a B, but some B are not A.",
    )
    B_INHERITS_A = (
        "b_inherits_a",
        "B is a kind of A: every B is an A, but some A are not B.",
    )
    OVERLAP = (
        "overlap",
        "Some things are both A and B, but each also covers things the other does not.",
    )
    EXCLUDES = (
        "excludes",
        "Nothing is both A and B: they are disjoint, or two different individuals.",
    )
    NO_REFERENCE = (
        "no_reference",
        "A or B picks out nothing that exists.",
    )


class Share(DescribedIntEnum):
    NONE = 0, "None of them."
    TINY = 1, "A tiny fraction: well under one in a hundred."
    FEW = 2, "A few of them: roughly one in ten to one in four."
    ABOUT_HALF = 3, "Roughly half of them."
    MOST = 4, "Most of them."
    ALL = 5, "All of them."


SHARE_STRENGTH = {
    Share.NONE: 0.0,
    Share.TINY: 0.01,
    Share.FEW: 0.15,
    Share.ABOUT_HALF: 0.5,
    Share.MOST: 0.85,
    Share.ALL: 1.0,
}


class ExtensionPair(BaseModel):
    """Context keys `a` and `b`: bare terms, or objects locating phrases in the state's text."""

    extension: Extension = Field(
        description="What is the relation between the things `a` (A) picks out and the "
        "things `b` (B) picks out?"
    )
    a_in_b: Share = Field(description="Of the things `a` picks out, how many are also picked out by `b`?")
    b_in_a: Share = Field(description="Of the things `b` picks out, how many are also picked out by `a`?")


class Kind(DescribedStrEnum):
    INDIVIDUAL = (
        "individual",
        "One particular thing: a single person, animal, object, place or organisation.",
    )
    KIND = (
        "kind",
        "A kind, species or class as a whole, including when it is spoken of with 'the' or as "
        "a single thing (as in 'the tiger is endangered').",
    )
    GROUP = (
        "group",
        "A particular, limited collection of individuals, such as 'these three houses' or "
        "'the team'.",
    )


class KindOf(BaseModel):
    """Context key `phrase` (plus how to read it in the state's text)."""

    kind: Kind = Field(description="As `phrase` is used in the text, what does it pick out?")


class HasProperty(BaseModel):
    """Context keys `term` and `property`."""

    holds: bool = Field(
        description="Does `property` hold of what `term` picks out? For a kind, answer for its "
        "typical members; for an individual, for that individual."
    )


EXTENSION_FORM = JevForm(ExtensionPair)
KIND_FORM = JevForm(KindOf)
PROPERTY_FORM = JevForm(HasProperty)


@dataclass(frozen=True)
class PlnLink:
    type: str
    a: str
    b: str
    strength: float
    confidence: float


def _expected_share(filled: Filled[ExtensionPair], field: str) -> float:
    answer = filled.answers[field]
    return sum(p * SHARE_STRENGTH[Share(level)] for level, p in answer.probabilities.items())


def _jaccard(s_ab: float, s_ba: float) -> float:
    """|A∩B|/|A∪B| from P(B|A) and P(A|B)."""
    return 0.0 if min(s_ab, s_ba) == 0 else 1 / (1 / s_ab + 1 / s_ba - 1)


def p_individual(filled: Filled[KindOf]) -> float:
    return filled.answers["kind"].probabilities.get(Kind.INDIVIDUAL.value, 0.0)


def reconcile_kinds(
    p: dict[Extension, float], individual_a: float, individual_b: float
) -> dict[Extension, float]:
    """Only an individual can be a member, and an individual is not a kind of anything.
    Membership mass on a side that is probably not an individual moves to inheritance, and
    inheritance mass on a side that probably is one moves to membership."""
    p = dict(p)
    for member, inherits, individual in (
        (Extension.A_MEMBER_OF_B, Extension.A_INHERITS_B, individual_a),
        (Extension.B_MEMBER_OF_A, Extension.B_INHERITS_A, individual_b),
    ):
        to_inherits = p[member] * (1 - individual)
        to_member = p[inherits] * individual
        p[member] += to_member - to_inherits
        p[inherits] += to_inherits - to_member
    return p


def relation_probabilities(
    filled: Filled[ExtensionPair], individual_a: float | None = None, individual_b: float | None = None
) -> dict[Extension, float]:
    ext = filled.answers["extension"]
    p = {member: ext.probabilities.get(member.value, 0.0) for member in Extension}
    if individual_a is not None and individual_b is not None:
        p = reconcile_kinds(p, individual_a, individual_b)
    return p


def is_individual(kind: Filled[KindOf]) -> bool:
    return kind.value.kind is Kind.INDIVIDUAL


def typed_links(
    a: str, b: str, filled: Filled[ExtensionPair], kind_a: Filled[KindOf], kind_b: Filled[KindOf]
) -> list[PlnLink]:
    return links_between(
        a, b, filled, p_individual(kind_a), p_individual(kind_b), is_individual(kind_a), is_individual(kind_b)
    )


def links_between(
    a: str,
    b: str,
    filled: Filled[ExtensionPair],
    p_ind_a: float,
    p_ind_b: float,
    a_is_individual: bool,
    b_is_individual: bool,
) -> list[PlnLink]:
    """Link types follow what each side is. Two individuals can only be identical or not;
    an individual and a kind can only be member or not; only two kinds get Subset and
    Similarity. Strengths stay soft: the kind probabilities still shift the relation."""
    p = relation_probabilities(filled, p_ind_a, p_ind_b)
    c = filled.answers["extension"].confidence
    if a_is_individual and b_is_individual:
        return [PlnLink("IdenticalLink", a, b, p[Extension.SAME_REFERENCE], c)]
    if a_is_individual:
        return [PlnLink("MemberLink", a, b, p[Extension.A_MEMBER_OF_B], c)]
    if b_is_individual:
        return [PlnLink("MemberLink", b, a, p[Extension.B_MEMBER_OF_A], c)]
    return [link for link in extension_links(a, b, filled, p_ind_a, p_ind_b) if link.type != "MemberLink"]


def extension_links(
    a: str,
    b: str,
    filled: Filled[ExtensionPair],
    individual_a: float | None = None,
    individual_b: float | None = None,
) -> list[PlnLink]:
    p = relation_probabilities(filled, individual_a, individual_b)
    c = filled.answers["extension"].confidence
    share_ab, share_ba = _expected_share(filled, "a_in_b"), _expected_share(filled, "b_in_a")

    # P(B|A) is 1 when A ⊆ B, Jev's graded share when A overlaps or contains B, 0 when disjoint.
    partial = p[Extension.OVERLAP]
    s_ab = p[Extension.SAME_REFERENCE] + p[Extension.A_INHERITS_B] + (partial + p[Extension.B_INHERITS_A]) * share_ab
    s_ba = p[Extension.SAME_REFERENCE] + p[Extension.B_INHERITS_A] + (partial + p[Extension.A_INHERITS_B]) * share_ba

    links = [
        PlnLink("SubsetLink", a, b, s_ab, c),
        PlnLink("SubsetLink", b, a, s_ba, c),
        PlnLink("ExtensionalSimilarityLink", a, b, _jaccard(s_ab, s_ba), c),
        PlnLink("MemberLink", a, b, p[Extension.A_MEMBER_OF_B], c),
        PlnLink("MemberLink", b, a, p[Extension.B_MEMBER_OF_A], c),
    ]
    # Near-zero Subset/Similarity strengths are negative evidence ("no whale is a fish") and are
    # kept; a near-zero MemberLink only says A is not an individual, so it is dropped.
    return [link for link in links if link.type != "MemberLink" or link.strength > MEMBER_MIN_STRENGTH]


def intension_links(
    a: str, b: str, props_a: Mapping[str, float], props_b: Mapping[str, float]
) -> list[PlnLink]:
    """Fuzzy-set overlaps of two property sets (membership = Jev's Noul), over the
    properties both were asked about. IntensionalInheritance A B = A has B's properties.
    Confidence grows with the number of properties judged (PLN's n / (n + k), k = 10)."""
    shared = props_a.keys() & props_b.keys()
    both = sum(min(props_a[x], props_b[x]) for x in shared)
    in_a, in_b = sum(props_a[x] for x in shared), sum(props_b[x] for x in shared)
    either = sum(max(props_a[x], props_b[x]) for x in shared)
    confidence = len(shared) / (len(shared) + PROPERTY_CONFIDENCE_K)
    return [
        PlnLink("IntensionalInheritanceLink", a, b, both / in_b if in_b else 0.0, confidence),
        PlnLink("IntensionalInheritanceLink", b, a, both / in_a if in_a else 0.0, confidence),
        PlnLink("IntensionalSimilarityLink", a, b, both / either if either else 0.0, confidence),
    ]


PROPERTY_CONFIDENCE_K = 10
INDIVIDUAL_THRESHOLD = 0.5
# A Noul carries no confidence of its own; this is a placeholder until calibrated.
NOUL_CONFIDENCE = 0.9

METTA_LINK = {
    "IdenticalLink": "Identical",
    "SubsetLink": "Subset",
    "MemberLink": "Member",
    "ExtensionalSimilarityLink": "ExtensionalSimilarity",
    "IntensionalInheritanceLink": "IntensionalInheritance",
    "IntensionalSimilarityLink": "IntensionalSimilarity",
}


def metta_symbol(term: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")


@dataclass(frozen=True)
class MentionAtom:
    """A mention node: its surface text and the entity it refers to."""

    name: str
    text: str
    entity: str
    strength: float
    confidence: float


def to_metta(
    links: list[PlnLink],
    individuals: Mapping[str, tuple[float, float]] | None = None,
    properties: Mapping[str, Mapping[str, float]] | None = None,
    mentions: list[MentionAtom] | None = None,
) -> str:
    """One `(≞ statement (STV strength confidence))` atom per link.

    ``individuals`` maps a term to (P(individual), confidence): the term is typed
    `Individual` or `Concept` by it, and the soft value is kept as `(IsIndividual x)`.
    ``mentions`` adds `Mention` nodes with their text and a `MentionOf` link to their entity.
    ``properties`` (term -> property -> Noul) let PLN derive intension itself."""
    individuals = individuals or {}
    terms = {t for link in links for t in (link.a, link.b)} | set(properties or {}) | set(individuals)
    lines = ["(: Concept Type)", "(: Individual Type)"]
    if mentions:
        lines.append("(: Mention Type)")
    for term in sorted(terms):
        p, _ = individuals.get(term, (0.0, 0.0))
        lines.append(f"(: {metta_symbol(term)} {'Individual' if p > INDIVIDUAL_THRESHOLD else 'Concept'})")
    for term, (p, c) in sorted(individuals.items()):
        lines.append(f"(≞ (IsIndividual {metta_symbol(term)}) (STV {p:.3f} {c:.3f}))")
    for m in mentions or []:
        lines.append(f"(: {metta_symbol(m.name)} Mention)")
        lines.append(f'(MentionText {metta_symbol(m.name)} "{m.text}")')
        lines.append(
            f"(≞ (MentionOf {metta_symbol(m.name)} {metta_symbol(m.entity)}) "
            f"(STV {m.strength:.3f} {m.confidence:.3f}))"
        )
    for link in links:
        statement = f"({METTA_LINK[link.type]} {metta_symbol(link.a)} {metta_symbol(link.b)})"
        lines.append(f"(≞ {statement} (STV {link.strength:.3f} {link.confidence:.3f}))")
    for term, props in (properties or {}).items():
        for prop, mu in props.items():
            lines.append(
                f"(≞ (HasProperty {metta_symbol(term)} {metta_symbol(prop)}) "
                f"(STV {mu:.3f} {NOUL_CONFIDENCE:.3f}))"
            )
    return "\n".join(lines)
