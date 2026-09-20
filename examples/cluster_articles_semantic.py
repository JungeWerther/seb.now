"""Cluster the same headlines as cluster_articles.py, with a real semantic
embedding instead of bag-of-words.

A pretrained transformer isn't reachable from this sandbox (huggingface.co
is blocked — see real_embedding_check.py). This trains one from scratch
instead: skip-gram over a small local corpus, self-supervised, no network
access needed. Word vectors emerge from co-occurrence, so "vote" should end
up near "election"/"poll"/"ballot" because they appear in similar contexts
below — unlike bag_of_words_embed, which only sees literal word overlap
(that's why "Vote count tightens..." split into its own cluster in
cluster_articles.py: it shares zero words with the other election
headlines).

A text's embedding sums its trained word vectors. Sum-pooling makes the
homomorphism law hold by construction (sum-of-sums = sum-of-concatenation,
whatever the per-word vectors turn out to be) — Combinable's check here
confirms that structural guarantee rather than testing a real risk, unlike
the attention-based TrainableEmbed in train_compositional_embedding.py.

Run with:
    uv run --group examples python examples/cluster_articles_semantic.py
"""

from __future__ import annotations

from itertools import chain

import torch
from torch import Tensor, nn

from seb_now.algebra import Combinable, Embed, SampleTriple, Vector, vec_add, vec_isclose
from seb_now.clustering import TopicClusterer

CORPUS = [
    "the election results show a close vote",
    "voters cast their ballot in the election",
    "the candidate leads in the latest poll",
    "poll numbers shift after the debate",
    "election officials count every vote and ballot",
    "the candidate campaigns ahead of the vote",
    "voter turnout affects the election outcome",
    "the poll predicts a narrow election vote",
    "fed raises interest rate amid inflation",
    "inflation data pushes the fed to cut rate",
    "stocks rally as the fed signals a rate cut",
    "market watches the fed for the next rate move",
    "rising inflation worries stock market investors",
    "the fed decision on rate moves the stock market",
]

HEADLINES = [
    "Fed signals rate cut as inflation cools",
    "Stocks rally after inflation data beats forecasts",
    "Market watches fed for next rate decision",
    "Candidate leads poll ahead of election",
    "Election officials report record ballot turnout",
    "Vote count tightens in key swing state",
]

DIM = 8
STOPWORDS = {"the", "a", "an", "of", "in", "on", "as", "to", "and", "their", "every", "next", "for"}


class SkipGram(nn.Module):
    def __init__(self, vocab_size: int, dim: int) -> None:
        super().__init__()
        self.in_embed = nn.Embedding(vocab_size, dim)
        self.out_proj = nn.Linear(dim, vocab_size)

    def forward(self, center_ids: Tensor) -> Tensor:
        return self.out_proj(self.in_embed(center_ids))


def build_vocab(tokenized: list[list[str]]) -> dict[str, int]:
    words = sorted(set(chain.from_iterable(tokenized)))
    return {word: i for i, word in enumerate(words)}


def skipgram_pairs(tokenized: list[list[str]], vocab: dict[str, int], window: int = 2) -> list[tuple[int, int]]:
    pairs = []
    for sentence in tokenized:
        ids = [vocab[word] for word in sentence]
        for i, center in enumerate(ids):
            for j in range(max(0, i - window), min(len(ids), i + window + 1)):
                if i != j:
                    pairs.append((center, ids[j]))
    return pairs


def train_word_vectors(dim: int = DIM, epochs: int = 800, lr: float = 0.05) -> tuple[dict[str, int], Tensor]:
    tokenized = [
        [word for word in sentence.split() if word not in STOPWORDS] for sentence in CORPUS
    ]
    vocab = build_vocab(tokenized)
    pairs = skipgram_pairs(tokenized, vocab, window=3)

    model = SkipGram(len(vocab), dim)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()

    centers = torch.tensor([c for c, _ in pairs])
    contexts = torch.tensor([o for _, o in pairs])

    for epoch in range(epochs):
        optimizer.zero_grad()
        loss = loss_fn(model(centers), contexts)
        loss.backward()
        optimizer.step()
        if epoch % 50 == 0:
            print(f"  epoch {epoch:4d}  skip-gram loss = {loss.item():.4f}")

    return vocab, model.in_embed.weight.detach()


def semantic_embed(vocab: dict[str, int], word_vectors: Tensor) -> Embed[Vector]:
    dim = word_vectors.shape[1]

    def embed(text: str) -> Vector:
        ids = [vocab[word] for word in text.lower().split() if word in vocab]
        if not ids:
            return tuple(0.0 for _ in range(dim))
        return tuple(float(v) for v in word_vectors[ids].sum(dim=0))

    return embed


def nearest_words(word: str, vocab: dict[str, int], word_vectors: Tensor, top_k: int = 4) -> list[str]:
    target = word_vectors[vocab[word]]
    similarities = nn.functional.cosine_similarity(target.unsqueeze(0), word_vectors)
    ranked = sorted(vocab, key=lambda w: -similarities[vocab[w]].item())
    return [w for w in ranked if w != word][:top_k]


def main() -> None:
    torch.manual_seed(0)
    print("Training skip-gram word vectors locally (no network, no pretrained weights)...")
    vocab, word_vectors = train_word_vectors()

    print()
    print(f"nearest words to 'vote':    {nearest_words('vote', vocab, word_vectors)}")
    print(f"nearest words to 'election': {nearest_words('election', vocab, word_vectors)}")
    print(f"nearest words to 'fed':     {nearest_words('fed', vocab, word_vectors)}")

    embed = semantic_embed(vocab, word_vectors)
    clusterer = TopicClusterer(
        embed=embed,
        combine_emb=vec_add,
        is_close=lambda a, b: vec_isclose(a, b, tol=1e-4),
        similarity_threshold=0.3,
    )

    combinable = Combinable(
        embed=embed,
        combine_text=lambda x, y: f"{x} {y}",
        combine_emb=vec_add,
        is_close=lambda a, b: vec_isclose(a, b, tol=1e-4),
    )
    samples = [SampleTriple(HEADLINES[0], HEADLINES[1], HEADLINES[2])]
    report = combinable.check(samples)
    print()
    print(f"Combinable check (sum-pooling is homomorphic by construction): holds={report.holds}")

    print()
    for headline in HEADLINES:
        cluster = clusterer.add_article(headline)
        cluster_id = clusterer.clusters.index(cluster)
        print(f"[cluster {cluster_id}] {headline}")


if __name__ == "__main__":
    main()
