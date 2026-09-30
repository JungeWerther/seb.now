"""Sense/reference links between noun phrases in one text, judged by Jev.

One request carries the text once (as state, with every mention marked
inline by id) and one question per mention pair. A mention is identified by
its id, its surface text and a few words either side, never by a bare
position index, which Jev resolves poorly.
"""

import math
from dataclasses import dataclass
from itertools import combinations

from pydantic import BaseModel, Field

from jev_fill import DescribedStrEnum, JevForm

CONTEXT_WORDS = 4
PRICE_USD_PER_MTOK = 0.042
CONTEXT_BUDGET_TOKENS = 64_000


class Relation(DescribedStrEnum):
    SAME_SENSE = (
        "same_sense",
        "Same referent AND same meaning: synonyms, or one defines the other, so anyone "
        "who understands both knows a priori they co-refer.",
    )
    SAME_REFERENCE_DIFFERENT_SENSE = (
        "same_reference_different_sense",
        "Both pick out the very same individual or thing, but through different "
        "descriptions or modes of presentation.",
    )
    DIFFERENT_REFERENCE = (
        "different_reference",
        "Both refer to something, but to different things.",
    )
    RELATED_NOT_IDENTICAL = (
        "related_not_identical",
        "The referents overlap or are closely related but are not the same thing: part and "
        "whole, a kind and one instance of it, a group and one member.",
    )
    NO_REFERENCE = (
        "no_reference",
        "At least one of the two fails to refer to anything that exists.",
    )


class MentionPair(BaseModel):
    relation: Relation = Field(
        description="In the text in the state, what is the relation between what `mention_a` "
        "refers to and what `mention_b` refers to?"
    )


@dataclass(frozen=True)
class Mention:
    id: str
    text: str
    start: int

    @property
    def end(self) -> int:
        return self.start + len(self.text)


def find_mentions(text: str, phrases: list[str]) -> list[Mention]:
    """Locate each phrase in order; a repeated phrase matches its next occurrence."""
    mentions, cursor = [], 0
    for index, phrase in enumerate(phrases, start=1):
        start = text.index(phrase, cursor)
        mentions.append(Mention(f"m{index}", phrase, start))
        cursor = start + len(phrase)
    return mentions


def marked_text(text: str, mentions: list[Mention]) -> str:
    """The state: every mention wrapped as ⟦m3: the morning star⟧."""
    out, cursor = [], 0
    for mention in sorted(mentions, key=lambda m: m.start):
        out.append(text[cursor : mention.start])
        out.append(f"⟦{mention.id}: {mention.text}⟧")
        cursor = mention.end
    out.append(text[cursor:])
    return "".join(out)


def mention_context(text: str, mention: Mention) -> dict[str, str]:
    before = text[: mention.start].split()[-CONTEXT_WORDS:]
    after = text[mention.end :].split()[:CONTEXT_WORDS]
    return {
        "id": mention.id,
        "text": mention.text,
        "in_context": " ".join([*before, f"[{mention.text}]", *after]),
    }


def pair_contexts(text: str, mentions: list[Mention]) -> dict[str, dict[str, dict[str, str]]]:
    """Unordered pairs only: the relations are symmetric, so n(n-1)/2 questions."""
    return {
        f"{a.id}-{b.id}": {
            "mention_a": mention_context(text, a),
            "mention_b": mention_context(text, b),
        }
        for a, b in combinations(mentions, 2)
    }


PAIR_FORM = JevForm(MentionPair)


@dataclass(frozen=True)
class CostEstimate:
    mentions: int
    questions: int
    requests: int
    input_tokens: int

    @property
    def usd(self) -> float:
        return self.input_tokens * PRICE_USD_PER_MTOK / 1_000_000


def pairwise_cost(n: int, state_tokens: int, tokens_per_pair: int) -> CostEstimate:
    """All pairs in as few requests as the 64k context allows; each request re-sends the state."""
    questions = n * (n - 1) // 2
    per_request = (CONTEXT_BUDGET_TOKENS - state_tokens) // tokens_per_pair
    requests = math.ceil(questions / per_request)
    return CostEstimate(n, questions, requests, requests * state_tokens + questions * tokens_per_pair)


def antecedent_cost(
    n: int, state_tokens: int, tokens_per_question: int, tokens_per_option: int
) -> CostEstimate:
    """One Choice per mention over the earlier mentions plus "new entity":
    n questions whose option lists grow, instead of n(n-1)/2 questions."""
    question_tokens = [tokens_per_question + (i + 1) * tokens_per_option for i in range(n)]
    requests, used = 1, state_tokens
    for tokens in question_tokens:
        if used + tokens > CONTEXT_BUDGET_TOKENS:
            requests, used = requests + 1, state_tokens
        used += tokens
    return CostEstimate(n, n, requests, requests * state_tokens + sum(question_tokens))
