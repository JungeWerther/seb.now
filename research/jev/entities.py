"""Merge mentions that pick out the same thing into entities, and lift links to them.

1. Merge: two mentions are joined when P(same_reference), after the kind rule, reaches
   MERGE_THRESHOLD; joins are transitive (union-find). A pair that ends up in one entity
   only through a chain, while its own P(same) is below CONFLICT_THRESHOLD, is reported:
   the pairwise answers contradict each other there.
2. Entity nodes: named after their first mention, typed by the mean P(individual) of
   their mentions. Each mention gets `MentionOf` with strength = its mean P(same) with
   the entity's other mentions (1 for a lone mention).
3. Entity links: every mention pair across two entities is separate evidence about the
   same entity link; they are combined with PLN's revision rule (strengths weighted by
   evidence count n = k·c / (1 − c), combined confidence N / (N + k)).
"""

from collections import defaultdict
from dataclasses import dataclass

from terms import (
    Extension,
    MentionAtom,
    PlnLink,
    links_between,
    p_individual,
    relation_probabilities,
    to_metta,
)
from text_pairs import TextJudgment, mention_name

MERGE_THRESHOLD = 0.7
CONFLICT_THRESHOLD = 0.3
REVISION_K = 1.0
MAX_CONFIDENCE = 0.99
SYMMETRIC_LINKS = {"IdenticalLink", "ExtensionalSimilarityLink"}


@dataclass(frozen=True)
class Entity:
    name: str
    mention_ids: tuple[str, ...]
    p_individual: float
    confidence: float

    @property
    def is_individual(self) -> bool:
        return self.p_individual > 0.5


@dataclass(frozen=True)
class EntityGraph:
    entities: list[Entity]
    mentions: list[MentionAtom]
    links: list[PlnLink]
    conflicts: list[tuple[str, str, float]]


def _same(judgment: TextJudgment) -> dict[tuple[str, str], tuple[float, float]]:
    out = {}
    for key, pair in judgment.pairs.items():
        a, b = key.split("-")
        p = relation_probabilities(pair, p_individual(judgment.kinds[a]), p_individual(judgment.kinds[b]))
        out[a, b] = out[b, a] = (p[Extension.SAME_REFERENCE], pair.answers["extension"].confidence)
    return out


def _clusters(ids: list[str], same: dict[tuple[str, str], tuple[float, float]]) -> list[list[str]]:
    parent = {i: i for i in ids}

    def find(i: str) -> str:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for (a, b), (s, _) in same.items():
        if s >= MERGE_THRESHOLD:
            parent[find(b)] = find(a)
    groups: dict[str, list[str]] = defaultdict(list)
    for i in ids:
        groups[find(i)].append(i)
    return sorted(groups.values(), key=lambda g: ids.index(g[0]))


def revise(links: list[PlnLink]) -> PlnLink:
    """PLN revision of independent evidence about one link."""
    counts = [REVISION_K * min(l.confidence, MAX_CONFIDENCE) / (1 - min(l.confidence, MAX_CONFIDENCE)) for l in links]
    total = sum(counts)
    strength = sum(n * l.strength for n, l in zip(counts, links)) / total if total else 0.0
    first = links[0]
    return PlnLink(first.type, first.a, first.b, strength, total / (total + REVISION_K))


def _labels(groups: list[list[str]], by_id: dict) -> list[str]:
    """Each entity is labelled by its first mention; where two entities would share a label
    ("the bank", "the bank"), each takes its longest mention instead."""
    first = [by_id[g[0]].text.lower() for g in groups]
    return [
        max((by_id[i].text for i in g), key=len) if first.count(first[n]) > 1 else by_id[g[0]].text
        for n, g in enumerate(groups)
    ]


def build_entities(judgment: TextJudgment) -> EntityGraph:
    by_id = {m.id: m for m in judgment.mentions}
    ids = [m.id for m in judgment.mentions]
    same = _same(judgment)
    groups = _clusters(ids, same)

    labels = _labels(groups, by_id)
    entities, entity_of, mentions, conflicts = [], {}, [], []
    for index, (group, label) in enumerate(zip(groups, labels), start=1):
        kinds = [judgment.kinds[i] for i in group]
        entity = Entity(
            name=f"e{index} {label}",
            mention_ids=tuple(group),
            p_individual=sum(p_individual(k) for k in kinds) / len(kinds),
            confidence=sum(k.answers["kind"].confidence for k in kinds) / len(kinds),
        )
        entities.append(entity)
        for i in group:
            entity_of[i] = entity
            others = [same[i, j] for j in group if j != i]
            strength = sum(s for s, _ in others) / len(others) if others else 1.0
            confidence = sum(c for _, c in others) / len(others) if others else 1.0
            mentions.append(MentionAtom(mention_name(by_id[i]), by_id[i].text, entity.name, strength, confidence))
        conflicts += [
            (a, b, same[a, b][0])
            for x, a in enumerate(group) for b in group[x + 1 :]
            if same[a, b][0] < CONFLICT_THRESHOLD
        ]

    evidence: dict[tuple[str, str, str], list[PlnLink]] = defaultdict(list)
    for key, pair in judgment.pairs.items():
        a, b = key.split("-")
        ea, eb = entity_of[a], entity_of[b]
        if ea is eb:
            continue
        for link in links_between(
            ea.name, eb.name, pair, ea.p_individual, eb.p_individual, ea.is_individual, eb.is_individual
        ):
            x, y = (sorted((link.a, link.b)) if link.type in SYMMETRIC_LINKS else (link.a, link.b))
            evidence[link.type, x, y].append(PlnLink(link.type, x, y, link.strength, link.confidence))
    links = [revise(group) for group in evidence.values()]
    return EntityGraph(entities, mentions, links, conflicts)


def entity_metta(graph: EntityGraph) -> str:
    individuals = {e.name: (e.p_individual, e.confidence) for e in graph.entities}
    return to_metta(graph.links, individuals, mentions=graph.mentions)
