"""Run the Combinable law-checker against a real sentence-transformer model.

Confirms, empirically, what hashed_embed() only stood in for: a contextual
encoder's embed(x + y) has no fixed relationship to embed(x) and embed(y),
because self-attention lets x and y's tokens see each other once they're
concatenated. Not part of the test suite — it downloads a ~90MB model, so
it's opt-in rather than something every CI run pays for.

Run with:
    uv run --group examples python examples/real_embedding_check.py
"""

from itertools import product

from sentence_transformers import SentenceTransformer

from seb_now.algebra import Combinable, Embed, LawCheckKind, SampleTriple, Vector, vec_add, vec_isclose
from seb_now.constants import ModelName, REAL_EMBEDDING_LAW_CHECK_TOLERANCE


def real_embed(model: SentenceTransformer) -> Embed[Vector]:
    def embed(text: str) -> Vector:
        return tuple(float(v) for v in model.encode(text, show_progress_bar=False))

    return embed


def join_with_space(x: str, y: str) -> str:
    return f"{x} {y}"


def main() -> None:
    model = SentenceTransformer(ModelName.ALL_MINI_LM_L6_V2)

    combinable = Combinable(
        embed=real_embed(model),
        combine_text=join_with_space,
        combine_emb=vec_add,
        is_close=lambda a, b: vec_isclose(a, b, tol=REAL_EMBEDDING_LAW_CHECK_TOLERANCE),
    )

    samples = [
        SampleTriple(x, y, z)
        for x, y, z in product(
            ["the market fell sharply", "prices rose today"],
            ["after the announcement"],
            ["analysts were surprised"],
        )
    ]

    report = combinable.check(samples)

    print(f"samples checked:               {report.total}")
    print(f"source associativity failures: {len(report.failures(LawCheckKind.SOURCE_ASSOCIATIVITY))}")
    print(f"homomorphism failures:         {len(report.failures(LawCheckKind.HOMOMORPHISM))}")
    print(f"combinator associativity fail: {len(report.failures(LawCheckKind.COMBINATOR_ASSOCIATIVITY))}")
    print(f"full law failures:             {len(report.failures(LawCheckKind.FULL_LAW))}")
    print()
    print(f"law holds overall: {report.holds}")


if __name__ == "__main__":
    main()
