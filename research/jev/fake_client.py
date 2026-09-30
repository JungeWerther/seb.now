from collections.abc import Mapping

from typesafe_sdk import JSONContent, Question, SystemOneResponse


class FakeClient:
    """Answers every Choice with its first option, every Score with its top level, every Noul 0.8."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def system_one(self, state: JSONContent, questions: Mapping[str, Question], **kwargs: object) -> SystemOneResponse:
        self.calls.append({"state": state, "questions": questions, **kwargs})
        answers = {}
        for key, q in questions.items():
            if q.type == "choice":
                first = next(iter(q.criteria))
                answers[key] = {"type": "choice", "choice": first, "confidence": 1.0,
                                "probabilities": {o: float(o == first) for o in q.criteria}}
            elif q.type == "score":
                top = len(q.criteria) - 1
                answers[key] = {"type": "score", "score": float(top), "confidence": 1.0,
                                "legend": {i: c for i, c in enumerate(q.criteria)},
                                "probabilities": {i: float(i == top) for i in range(len(q.criteria))}}
            else:
                answers[key] = {"type": "noul", "noul": 0.8}
        return SystemOneResponse.model_validate({"model": "fake", "usage": {"input_tokens": 0}, "answers": answers})
