import json
import sys

from pydantic import BaseModel, Field
from collections.abc import Mapping

from typesafe_sdk import JSONContent, Question, SystemOneResponse

from coref import PAIR_FORM, find_mentions, marked_text, pair_contexts
from jev_fill import DescribedIntEnum, DescribedStrEnum, JevForm

from sample import PHRASES, TEXT

mentions = find_mentions(TEXT, PHRASES)
state = marked_text(TEXT, mentions)
contexts = pair_contexts(TEXT, mentions)

if sys.argv[1:] == ["request"]:
    questions = {}
    for key, context in contexts.items():
        questions.update(PAIR_FORM.questions(context, key))
    body = {
        "model": "jev-1.13.0",
        "state": state,
        "questions": {k: q.model_dump(mode="json") for k, q in questions.items()},
    }
    print(json.dumps(body, ensure_ascii=False))
    sys.exit()


class Tone(DescribedStrEnum):
    NEUTRAL = "neutral", "Reports facts without taking a side."
    CRITICAL = "critical", "Criticises someone or something."


class Hype(DescribedIntEnum):
    NONE = 0, "Plain, no exaggeration."
    SOME = 1, "Some promotional or exaggerated wording."
    HEAVY = 2, "Breathless, superlative-laden."


class Headline(BaseModel):
    tone: Tone = Field(description="What is the tone of the headline?")
    hype: Hype = Field(description="How much hype is in the headline?")
    is_about_ai: bool = Field(description="Is the headline about artificial intelligence?")


class FakeClient:
    """Answers every question with the first option / level 2 / 0.8, and records calls."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def system_one(self, state: JSONContent, questions: Mapping[str, Question], **kwargs: object) -> SystemOneResponse:
        self.calls.append(questions)
        answers = {}
        for key, q in questions.items():
            if q.type == "choice":
                first = next(iter(q.criteria))
                probabilities = {option: float(option == first) for option in q.criteria}
                answers[key] = {"type": "choice", "choice": first, "probabilities": probabilities, "confidence": 1.0}
            elif q.type == "score":
                levels = {i: float(i == 2) for i in range(len(q.criteria))}
                answers[key] = {"type": "score", "score": 2.0, "legend": {i: c for i, c in enumerate(q.criteria)},
                                "probabilities": levels, "confidence": 1.0}
            else:
                answers[key] = {"type": "noul", "noul": 0.8}
        return SystemOneResponse.model_validate({"model": "fake", "usage": {"input_tokens": 0}, "answers": answers})


client = FakeClient()
filled = JevForm(Headline).fill(client, "OpenAI unveils its most powerful model ever")
print(filled.value, "| raw noul:", filled.answers["is_about_ai"].noul)
print(json.dumps({k: q.model_dump(mode="json") for k, q in client.calls[0].items()}, indent=1)[:900])

client = FakeClient()
pairs = PAIR_FORM.fill_many(client, state, contexts, max_questions_per_request=50)
print(len(pairs), "pairs in", len(client.calls), "requests; first:", pairs["m1-m2"].value)
print("state:", state)
print("one pair question:", json.dumps(PAIR_FORM.questions(contexts["m2-m11"], "m2-m11"), default=lambda q: q.model_dump(mode="json"), ensure_ascii=False, indent=1))
