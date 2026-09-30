"""Fill a pydantic model's fields with Jev judgments.

The field's type decides the question:

- a ``DescribedStrEnum``  -> Choice (one option per member)
- a ``DescribedIntEnum``  -> Score  (members are ordered levels 0..k-1)
- ``bool``                -> Noul

The field's ``description`` is the question. Each enum member carries its own
criterion text, so the option definitions live next to the type, not in a prompt.
"""

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from enum import IntEnum, StrEnum
from typing import Generic, Protocol, TypeVar

from pydantic import BaseModel
from typesafe_sdk import (
    Choice,
    ChoiceAnswer,
    JSONContent,
    Noul,
    NoulAnswer,
    Question,
    Score,
    ScoreAnswer,
    SystemOneResponse,
)

NOUL_THRESHOLD = 0.5
MAX_QUESTIONS_PER_REQUEST = 200
KEY_SEPARATOR = "."

M = TypeVar("M", bound=BaseModel)
Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer


class DescribedStrEnum(StrEnum):
    """A StrEnum whose members are declared as ``NAME = "value", "criterion"``."""

    description: str

    def __new__(cls, value: str, description: str) -> "DescribedStrEnum":
        member = str.__new__(cls, value)
        member._value_ = value
        member.description = description
        return member


class DescribedIntEnum(IntEnum):
    """An IntEnum of ordered Score levels, declared as ``NAME = 0, "level description"``."""

    description: str

    def __new__(cls, value: int, description: str) -> "DescribedIntEnum":
        member = int.__new__(cls, value)
        member._value_ = value
        member.description = description
        return member


class SystemOneClient(Protocol):
    def system_one(
        self, state: JSONContent, questions: Mapping[str, Question], **kwargs: object
    ) -> SystemOneResponse: ...


@dataclass(frozen=True)
class Filled(Generic[M]):
    """The filled model plus the raw answers, so probabilities stay reusable."""

    value: M
    answers: dict[str, Answer]


class JevForm(Generic[M]):
    """Turns a pydantic model into Jev questions and parses the answers back into it."""

    def __init__(self, model: type[M]) -> None:
        self.model = model
        self._templates: dict[str, Question] = {
            name: _question_for(name, field.annotation, field.description, field.json_schema_extra)
            for name, field in model.model_fields.items()
        }
        self._extras: dict[str, dict[str, JSONContent]] = {
            name: dict((field.json_schema_extra or {}).get("instructions", {}))
            for name, field in model.model_fields.items()
        }

    def questions(
        self, context: Mapping[str, JSONContent] | None = None, key: str | None = None
    ) -> dict[str, Question]:
        """One question per field. ``context`` and the field's own extra instruction fields
        (``json_schema_extra={"instructions": {...}}``, e.g. a definition) are placed beside
        the question text, so it can refer to them by name in backticks."""
        out: dict[str, Question] = {}
        for name, template in self._templates.items():
            question_id = f"{key}{KEY_SEPARATOR}{name}" if key else name
            beside = {**self._extras[name], **(context or {})}
            instructions = (
                {**beside, "question": template.instructions} if beside else template.instructions
            )
            out[question_id] = template.model_copy(update={"instructions": instructions})
        return out

    def parse(self, answers: Mapping[str, Answer], key: str | None = None) -> Filled[M]:
        values: dict[str, object] = {}
        raw: dict[str, Answer] = {}
        for name, field in self.model.model_fields.items():
            answer = answers[f"{key}{KEY_SEPARATOR}{name}" if key else name]
            raw[name] = answer
            values[name] = _value_from(field.annotation, answer)
        return Filled(value=self.model(**values), answers=raw)

    def fill(
        self,
        client: SystemOneClient,
        state: JSONContent,
        context: Mapping[str, JSONContent] | None = None,
        **kwargs: object,
    ) -> Filled[M]:
        response = client.system_one(state, self.questions(context), **kwargs)
        return self.parse(response.answers)

    def fill_many(
        self,
        client: SystemOneClient,
        state: JSONContent,
        contexts: Mapping[str, Mapping[str, JSONContent]],
        max_questions_per_request: int = MAX_QUESTIONS_PER_REQUEST,
        **kwargs: object,
    ) -> dict[str, Filled[M]]:
        """Fill one model per context key against a shared state.

        Questions are packed into as few requests as ``max_questions_per_request``
        allows; each extra request re-sends the state."""
        questions: dict[str, Question] = {}
        for key, context in contexts.items():
            questions.update(self.questions(context, key))
        answers: dict[str, Answer] = {}
        for batch in chunks(questions, max_questions_per_request):
            answers.update(client.system_one(state, batch, **kwargs).answers)
        return {key: self.parse(answers, key) for key in contexts}


def _question_for(name: str, annotation: object, description: str | None, extra: object) -> Question:
    if not description:
        raise TypeError(f"field {name!r} needs a description: it is the question Jev answers")
    if isinstance(annotation, type) and issubclass(annotation, DescribedStrEnum):
        return Choice(
            instructions=description,
            criteria={member.value: member.description for member in annotation},
        )
    if isinstance(annotation, type) and issubclass(annotation, DescribedIntEnum):
        levels = sorted(annotation, key=int)
        if [int(level) for level in levels] != list(range(len(levels))):
            raise TypeError(f"{annotation.__name__} levels must be 0..{len(levels) - 1}")
        return Score(instructions=description, criteria=[level.description for level in levels])
    if annotation is bool:
        criteria = extra.get("criteria") if isinstance(extra, dict) else None
        return Noul(instructions=description, criteria=criteria)
    raise TypeError(
        f"field {name!r}: {annotation!r} is not a DescribedStrEnum, DescribedIntEnum or bool"
    )


def _value_from(annotation: type, answer: Answer) -> object:
    if isinstance(answer, ChoiceAnswer):
        return annotation(answer.choice)
    if isinstance(answer, ScoreAnswer):
        return annotation(int(max(answer.probabilities, key=answer.probabilities.__getitem__)))
    return answer.noul >= NOUL_THRESHOLD


def chunks(questions: dict[str, Question], size: int) -> Iterator[dict[str, Question]]:
    items = list(questions.items())
    for start in range(0, len(items), size):
        yield dict(items[start : start + size])
