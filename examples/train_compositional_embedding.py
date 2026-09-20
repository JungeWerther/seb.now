"""Train a tiny attention-based embedder against the homomorphism law itself.

TrainableEmbed is the class container the training loop needs: a learnable
per-word embedding table plus one self-attention layer, so encoding a
concatenated text lets attention mix tokens across the x/y boundary — the
same mechanism that breaks compositionality in real contextual encoders
(see algebra.py's module docstring). Untrained, it fails Combinable's
homomorphism check for the same reason hashed_embed() does.

Instead of just checking the law (algebra.py), this trains against it:
homomorphism_loss is the same identity full_law_holds checks, made
differentiable (MSE instead of is_close), and backpropagated into the
model's parameters. as_embed() wraps the trained model in torch.no_grad()
and tuple conversion so the existing Combinable/LawReport machinery
evaluates it unchanged.

Self-contained: a from-scratch model, no pretrained weights, no network
access needed. Run with:
    uv run --group examples python examples/train_compositional_embedding.py
"""

from __future__ import annotations

import random
from itertools import product

import torch
from torch import Tensor, nn

from seb_now.algebra import Combinable, Embed, SampleTriple, Vector, vec_add, vec_isclose
from seb_now.constants import (
    ATTENTION_BATCH_FIRST,
    ATTENTION_EMBEDDING_DIM,
    SELF_ATTENTION_NUM_HEADS,
    TRAINABLE_EMBED_LAW_CHECK_TOLERANCE,
    TRAINABLE_EMBED_LEARNING_RATE,
    TRAINABLE_EMBED_TRAIN_STEPS,
)

VOCAB = [
    "macro", "prices", "rose", "fell", "today",
    "after", "announcement", "analysts", "surprised", "sharply",
]
WORD_TO_INDEX = {word: i for i, word in enumerate(VOCAB)}

TEXTS = [
    "macro prices",
    "rose today",
    "fell sharply",
    "after announcement",
    "analysts surprised",
]


class TrainableEmbed(nn.Module):
    """The trainable mapping: a token table + one self-attention layer over it."""

    def __init__(self, vocab_size: int, dim: int) -> None:
        super().__init__()
        self.token_embedding = nn.Embedding(vocab_size, dim)
        self.attention = nn.MultiheadAttention(
            dim, num_heads=SELF_ATTENTION_NUM_HEADS, batch_first=ATTENTION_BATCH_FIRST
        )

    def forward(self, token_ids: Tensor) -> Tensor:
        tokens = self.token_embedding(token_ids)  # (1, seq_len, dim)
        attended, _ = self.attention(tokens, tokens, tokens)
        return attended.mean(dim=1).squeeze(0)  # (dim,)

    def encode(self, text: str) -> Tensor:
        ids = torch.tensor([[WORD_TO_INDEX[word] for word in text.lower().split()]])
        return self.forward(ids)

    def as_embed(self) -> Embed[Vector]:
        def embed(text: str) -> Vector:
            with torch.no_grad():
                return tuple(float(v) for v in self.encode(text))

        return embed


def combine_text(x: str, y: str) -> str:
    return f"{x} {y}"


def homomorphism_loss(model: TrainableEmbed, x: str, y: str) -> Tensor:
    combined = model.encode(combine_text(x, y))
    predicted = model.encode(x) + model.encode(y)
    return nn.functional.mse_loss(combined, predicted)


def train(
    model: TrainableEmbed,
    steps: int = TRAINABLE_EMBED_TRAIN_STEPS,
    lr: float = TRAINABLE_EMBED_LEARNING_RATE,
) -> None:
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    pairs = list(product(TEXTS, TEXTS))
    for step in range(steps):
        x, y = random.choice(pairs)
        optimizer.zero_grad()
        loss = homomorphism_loss(model, x, y)
        loss.backward()
        optimizer.step()
        if step % 50 == 0:
            print(f"  step {step:4d}  homomorphism loss = {loss.item():.4f}")


def evaluate(model: TrainableEmbed) -> None:
    combinable = Combinable(
        embed=model.as_embed(),
        combine_text=combine_text,
        combine_emb=vec_add,
        is_close=lambda a, b: vec_isclose(a, b, tol=TRAINABLE_EMBED_LAW_CHECK_TOLERANCE),
    )
    samples = [
        SampleTriple(x, y, z)
        for x, y, z in product(TEXTS[:2], TEXTS[2:3], TEXTS[3:4])
    ]
    report = combinable.check(samples)
    print(f"  homomorphism failures: {len(report.homomorphism_failures)} / {report.total}")
    print(f"  full law failures:     {len(report.full_law_failures)} / {report.total}")


def main() -> None:
    torch.manual_seed(0)
    random.seed(0)
    model = TrainableEmbed(vocab_size=len(VOCAB), dim=ATTENTION_EMBEDDING_DIM)

    print("Before training:")
    evaluate(model)

    print()
    print("Training against the homomorphism loss...")
    train(model)

    print()
    print("After training:")
    evaluate(model)


if __name__ == "__main__":
    main()
