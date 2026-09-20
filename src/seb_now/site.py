"""Renders the seb.now homepage: headlines grouped into topics by TopicClusterer.

This is the same clustering path as examples/cluster_articles.py — bag_of_words_embed
over a fixed vocab, folded incrementally with vec_add. The headlines here are a
placeholder front page until article ingestion exists; swapping in real articles
later only means replacing HEADLINES/VOCAB with an ingested feed.
"""

from __future__ import annotations

import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from seb_now.algebra import bag_of_words_embed, vec_add, vec_isclose
from seb_now.clustering import TopicCluster, TopicClusterer
from seb_now.constants import BAG_OF_WORDS_SIMILARITY_THRESHOLD, DEFAULT_SITE_OUTPUT_DIR

VOCAB = (
    "fed", "rate", "inflation", "market", "stocks",
    "election", "vote", "poll", "candidate", "ballot",
)

HEADLINES = (
    "Fed signals rate cut as inflation cools",
    "Stocks rally after inflation data beats forecasts",
    "Market watches fed for next rate decision",
    "Candidate leads poll ahead of election",
    "Election officials report record ballot turnout",
    "Vote count tightens in key swing state",
)

TEMPLATES_DIR = Path(__file__).parent / "templates"


def cluster_headlines() -> list[TopicCluster]:
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(VOCAB),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=BAG_OF_WORDS_SIMILARITY_THRESHOLD,
    )
    for headline in HEADLINES:
        clusterer.add_article(headline)
    return clusterer.clusters


def render_site(output_dir: Path) -> None:
    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("index.html")
    html = template.render(clusters=cluster_headlines())

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "index.html").write_text(html)


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(DEFAULT_SITE_OUTPUT_DIR)
    render_site(target)
    print(f"wrote {target / 'index.html'}")


if __name__ == "__main__":
    main()
