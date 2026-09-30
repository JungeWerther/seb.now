from hyperon import MeTTa
metta = MeTTa()
metta.run(open("jev_terms.metta").read())
queries = {
    "What is a subset of birds, and how strongly?":
        "!(match &self (≞ (Subset $x birds) (STV $s $c)) ($x $s $c))",
    "Which Subset links hold with strength > 0.9 and confidence > 0.9?":
        "!(match &self (≞ (Subset $a $b) (STV $s $c)) (if (and (> $s 0.9) (> $c 0.9)) ($a ⊆ $b) (empty)))",
    "Members:":
        "!(match &self (≞ (Member $a $b) $tv) ($a ∈ $b $tv))",
    "Most intensionally similar pairs (> 0.5):":
        "!(match &self (≞ (IntensionalSimilarity $a $b) (STV $s $c)) (if (> $s 0.5) ($a ~ $b $s $c) (empty)))",
}
for label, q in queries.items():
    print(label)
    for result in metta.run(q)[0]:
        print("  ", result)
