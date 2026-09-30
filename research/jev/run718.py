import json
from typesafe_sdk import ChoiceAnswer, ScoreAnswer
from terms import EXTENSION_FORM, extension_links, to_metta

PAIRS = {"p01": ("the morning star", "the evening star"), "p02": ("bachelors", "unmarried men"),
         "p03": ("Venus", "the planets of the solar system"), "p04": ("whales", "mammals"),
         "p05": ("animals", "dogs"), "p06": ("birds", "things that can fly"), "p07": ("whales", "fish"),
         "p08": ("the present king of France", "kings"), "p09": ("Walter Scott", "Charles Dickens"),
         "p10": ("penguins", "birds"), "p11": ("mammals", "egg-laying animals"), "p12": ("US presidents", "lawyers")}

raw = json.load(open("answers718.json"))
answers = {}
for key, a in raw.items():
    if key.endswith(".extension"):
        answers[key] = ChoiceAnswer(choice=max(a["p"], key=a["p"].get), probabilities=a["p"], confidence=a["c"])
    else:
        probs = {i: a["p"].get(str(i), 0.0) for i in range(6)}
        answers[key] = ScoreAnswer(score=sum(i * v for i, v in probs.items()), legend={i: "" for i in range(6)},
                                   probabilities=probs, confidence=a["c"])

links = []
for k, (a, b) in PAIRS.items():
    filled = EXTENSION_FORM.parse(answers, k)
    links += extension_links(a, b, filled)
open("jev_terms.metta", "w").write(to_metta(links) + "\n")
print(open("jev_terms.metta").read())
