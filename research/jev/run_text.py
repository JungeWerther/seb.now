"""Rebuild TextJudgments from the live answers (relayed via pg_net) and emit typed MeTTa."""
import json

from typesafe_sdk import ChoiceAnswer, ScoreAnswer

import bank_text
import sample_text
from terms import EXTENSION_FORM, KIND_FORM
from text_pairs import Locate, TextJudgment, find_mentions, pair_contexts, text_metta


def answers_from(path: str) -> dict:
    out = {}
    for key, a in json.load(open(path)).items():
        if key.endswith((".extension", ".kind")):
            out[key] = ChoiceAnswer(choice=max(a["p"], key=a["p"].get), probabilities=a["p"], confidence=a["c"])
        else:
            probs = {i: a["p"].get(str(i), 0.0) for i in range(6)}
            out[key] = ScoreAnswer(score=sum(i * v for i, v in probs.items()), legend={i: "" for i in range(6)},
                                   probabilities=probs, confidence=a["c"])
    return out


for name, module, path in (("whales", sample_text, "answers732.json"), ("bank", bank_text, "answers731.json")):
    answers = answers_from(path)
    mentions = find_mentions(module.TEXT, module.PHRASES)
    judgment = TextJudgment(
        mentions,
        {m.id: KIND_FORM.parse(answers, m.id) for m in mentions},
        {k: EXTENSION_FORM.parse(answers, k) for k in pair_contexts(module.TEXT, mentions, Locate.BOTH)},
    )
    metta = text_metta(judgment)
    open(f"{name}.metta", "w").write(metta + "\n")
    print(f";; ===== {name} =====\n{metta}\n")


from entities import build_entities, entity_metta

for name, module, path in (("whales", sample_text, "answers732.json"), ("bank", bank_text, "answers731.json")):
    answers = answers_from(path)
    mentions = find_mentions(module.TEXT, module.PHRASES)
    judgment = TextJudgment(
        mentions,
        {m.id: KIND_FORM.parse(answers, m.id) for m in mentions},
        {k: EXTENSION_FORM.parse(answers, k) for k in pair_contexts(module.TEXT, mentions, Locate.BOTH)},
    )
    graph = build_entities(judgment)
    metta = entity_metta(graph)
    open(f"{name}_entities.metta", "w").write(metta + "\n")
    print(f";; ===== {name}: entities =====")
    for e in graph.entities:
        print(";;", e.name, "<-", ", ".join(e.mention_ids), f"(P individual {e.p_individual:.2f})")
    print(";; conflicts:", graph.conflicts or "none")
    print(metta, "\n")
