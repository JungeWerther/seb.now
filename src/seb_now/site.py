"""Render index.html: articles grouped by source type, each tagged with its topic cluster.

Feed: src/seb_now/data/articles.json (title + url pairs). Vocab: built from
the corpus itself, so it never drifts out of sync with the feed. Clustering:
TopicClusterer over titles, bag-of-words embedded. Grouping: classify_source
buckets each article's url into a SourceType; SOURCE_TYPE_LABELS's key order
is the page's group order (mainstream media, YouTube long-form, direct link).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Sequence

from seb_now.algebra import bag_of_words_embed, vec_add, vec_isclose
from seb_now.clustering import TopicClusterer
from seb_now.constants import BAG_OF_WORDS_SIMILARITY_THRESHOLD, SOURCE_TYPE_LABELS, SourceType
from seb_now.source_type import classify_source

DATA_DIR = Path(__file__).parent / "data"
TEMPLATES_DIR = Path(__file__).parent / "templates"
ARTICLES_PATH = DATA_DIR / "articles.json"
TEMPLATE_PATH = TEMPLATES_DIR / "index.html"
OUTPUT_PATH = Path(__file__).parent.parent.parent / "dist" / "index.html"

ARTICLES_PLACEHOLDER = "<!--ARTICLES-->"


@dataclass(frozen=True)
class Article:
    title: str
    url: str
    source_type: SourceType
    cluster_id: int


def _vocab(titles: Sequence[str]) -> list[str]:
    words: set[str] = set()
    for title in titles:
        words.update(title.lower().split())
    return sorted(words)


def load_feed() -> list[dict[str, str]]:
    return json.loads(ARTICLES_PATH.read_text())


def build_articles(feed: Sequence[dict[str, str]]) -> list[Article]:
    vocab = _vocab([item["title"] for item in feed])
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(vocab),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=BAG_OF_WORDS_SIMILARITY_THRESHOLD,
    )

    articles = []
    for item in feed:
        cluster = clusterer.add_article(item["title"])
        articles.append(
            Article(
                title=item["title"],
                url=item["url"],
                source_type=classify_source(item["url"]),
                cluster_id=clusterer.clusters.index(cluster),
            )
        )
    return articles


def _group_by_source_type(articles: Sequence[Article]) -> dict[SourceType, list[Article]]:
    groups: dict[SourceType, list[Article]] = {source_type: [] for source_type in SourceType}
    for article in articles:
        groups[article.source_type].append(article)
    return groups


def _render_article(article: Article) -> str:
    return (
        f'      <li class="article">'
        f'<a href="{escape(article.url)}">{escape(article.title)}</a>'
        f'<span class="cluster">cluster {article.cluster_id}</span>'
        f"</li>"
    )


def _render_group(source_type: SourceType, articles: Sequence[Article]) -> str:
    items = "\n".join(_render_article(article) for article in articles)
    label = escape(SOURCE_TYPE_LABELS[source_type])
    return (
        f'    <section class="source-group" data-source-type="{source_type.value}">\n'
        f"      <h2>{label}</h2>\n"
        f'      <ul class="articles">\n{items}\n      </ul>\n'
        f"    </section>"
    )


def render(articles: Sequence[Article]) -> str:
    groups = _group_by_source_type(articles)
    sections = "\n".join(
        _render_group(source_type, groups[source_type])
        for source_type in SOURCE_TYPE_LABELS
        if groups[source_type]
    )
    return TEMPLATE_PATH.read_text().replace(ARTICLES_PLACEHOLDER, sections)


def main() -> None:
    articles = build_articles(load_feed())
    html = render(articles)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(html)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
