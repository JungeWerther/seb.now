"""Extension links between noun phrases *in a text*, judged by Jev.

The text goes once into the state. Each question points at its phrase by a marker
(⟦m3: phrase⟧ in the state, id in the question), by a window of the words around it
("w w w [phrase] w w w"), or both; see ``Locate``. The surface text alone is ambiguous
when a phrase repeats ("the bank" ... "the bank").

Only extension is judged per mention pair: what a phrase picks out depends on where
it stands. Intension is a property of the concept, not of one occurrence, so it is
judged once per concept (terms.PROPERTY_FORM) and cached, not per mention pair.
"""

import os
import re
from dataclasses import dataclass
from enum import StrEnum
from itertools import combinations

from typesafe_sdk import JSONContent, TypeSafeClient

from jev_fill import MAX_QUESTIONS_PER_REQUEST, Filled, SystemOneClient, chunks
from terms import (
    EXTENSION_FORM,
    KIND_FORM,
    ExtensionPair,
    KindOf,
    PlnLink,
    p_individual,
    to_metta,
    typed_links,
)

MODEL = "jev-1.13.0"
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")
WINDOW_WORDS = 3
WORD = re.compile(r"\S+")


class Locate(StrEnum):
    """How a question points at its phrase in the text."""

    MARKER = "marker"  # state marks ⟦m3: phrase⟧; the question gives id + text
    WINDOW = "window"  # plain state; the question gives "w w w [phrase] w w w"
    BOTH = "both"


READING = {
    Locate.MARKER: "`a` and `b` are phrases from the text in the state, where each is marked "
    "⟦id: phrase⟧. Take each as used at its marked position: what it picks out there, given "
    "the whole text.",
    Locate.WINDOW: "`a` and `b` are phrases from the text in the state. Each is given with the "
    "words around it, the phrase itself in [brackets]. Take each as used at that place: what "
    "it picks out there, given the whole text.",
    Locate.BOTH: "`a` and `b` are phrases from the text in the state, where each is marked "
    "⟦id: phrase⟧, and each is also given with the words around it, the phrase in [brackets]. "
    "Take each as used at that place: what it picks out there, given the whole text.",
}


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
    out, cursor = [], 0
    for mention in sorted(mentions, key=lambda m: m.start):
        out += [text[cursor : mention.start], f"⟦{mention.id}: {mention.text}⟧"]
        cursor = mention.end
    return "".join([*out, text[cursor:]])


def window(text: str, mention: Mention, words: int = WINDOW_WORDS) -> str:
    """The phrase in [brackets] with ``words`` words either side, sliced from the text as is."""
    before = list(WORD.finditer(text, 0, mention.start))[-words:]
    after = list(WORD.finditer(text, mention.end))[:words]
    start = before[0].start() if before else mention.start
    end = after[-1].end() if after else mention.end
    return f"{text[start : mention.start]}[{mention.text}]{text[mention.end : end]}"


def reference(text: str, mention: Mention, locate: Locate) -> dict[str, str]:
    ref = {"text": mention.text}
    if locate in (Locate.MARKER, Locate.BOTH):
        ref = {"id": mention.id, **ref}
    if locate in (Locate.WINDOW, Locate.BOTH):
        ref["in_context"] = window(text, mention)
    return ref


def state_for(text: str, mentions: list[Mention], locate: Locate) -> str:
    return text if locate is Locate.WINDOW else marked_text(text, mentions)


def pair_contexts(
    text: str, mentions: list[Mention], locate: Locate
) -> dict[str, dict[str, JSONContent]]:
    return {
        f"{a.id}-{b.id}": {
            "reading": READING[locate],
            "a": reference(text, a, locate),
            "b": reference(text, b, locate),
        }
        for a, b in combinations(mentions, 2)
    }


def mention_contexts(
    text: str, mentions: list[Mention], locate: Locate
) -> dict[str, dict[str, JSONContent]]:
    reading = READING[locate].replace("`a` and `b` are phrases", "`phrase` is a phrase")
    return {m.id: {"reading": reading, "phrase": reference(text, m, locate)} for m in mentions}


@dataclass(frozen=True)
class TextJudgment:
    mentions: list[Mention]
    kinds: dict[str, Filled[KindOf]]
    pairs: dict[str, Filled[ExtensionPair]]


def judge_text(
    client: SystemOneClient,
    text: str,
    phrases: list[str],
    model: str = MODEL,
    locate: Locate = Locate.BOTH,
) -> TextJudgment:
    """The model call. One shared state; one kind-or-individual question per phrase and
    three questions per phrase pair, packed together into as few requests as the context
    budget allows (the per-phrase questions ride along with the pairs)."""
    mentions = find_mentions(text, phrases)
    state = state_for(text, mentions, locate)
    questions = {
        **{k: q for key, ctx in mention_contexts(text, mentions, locate).items()
           for k, q in KIND_FORM.questions(ctx, key).items()},
        **{k: q for key, ctx in pair_contexts(text, mentions, locate).items()
           for k, q in EXTENSION_FORM.questions(ctx, key).items()},
    }
    answers = {}
    for batch in chunks(questions, MAX_QUESTIONS_PER_REQUEST):
        answers.update(client.system_one(state, batch, model=model).answers)
    return TextJudgment(
        mentions,
        {m.id: KIND_FORM.parse(answers, m.id) for m in mentions},
        {key: EXTENSION_FORM.parse(answers, key) for key in pair_contexts(text, mentions, locate)},
    )


def mention_name(mention: Mention) -> str:
    return f"{mention.id} {mention.text}"


def text_links(judgment: TextJudgment) -> list[PlnLink]:
    name = {m.id: mention_name(m) for m in judgment.mentions}
    links: list[PlnLink] = []
    for key, pair in judgment.pairs.items():
        a, b = key.split("-")
        links += typed_links(name[a], name[b], pair, judgment.kinds[a], judgment.kinds[b])
    return links


def text_metta(judgment: TextJudgment) -> str:
    """Mention-level MeTTa: one node per occurrence. See entities.entity_metta for merged nodes."""
    individuals = {
        mention_name(m): (p_individual(judgment.kinds[m.id]), judgment.kinds[m.id].answers["kind"].confidence)
        for m in judgment.mentions
    }
    return to_metta(text_links(judgment), individuals)


if __name__ == "__main__":
    from sample_text import PHRASES, TEXT

    client = TypeSafeClient(api_key=os.environ["TYPESAFE_API_KEY"], model=MODEL)
    print(text_metta(judge_text(client, TEXT, PHRASES)))
