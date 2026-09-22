"""Render index.html: a flat list of articles, each tagged with its topic cluster.

Feed: the `links` table in Supabase (title + url per row), read with the
public anon client. Vocab: built from the corpus itself, so it never drifts
out of sync with the feed. Clustering: TopicClusterer over titles,
bag-of-words embedded. classify_source still tags each article's
SourceType (mainstream media / YouTube long-form / direct link) for future
filtering, but the page no longer groups or headers by it - each article
shows its own domain instead.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Sequence

from seb_now.algebra import bag_of_words_embed, vec_add, vec_isclose
from seb_now.clustering import TopicClusterer
from seb_now.constants import BAG_OF_WORDS_SIMILARITY_THRESHOLD, SourceType
from seb_now.auth import get_unauthenticated_client
from seb_now.domain.models import Link
from seb_now.source_type import classify_source, display_domain

TEMPLATES_DIR = Path(__file__).parent / "templates"
TEMPLATE_PATH = TEMPLATES_DIR / "index.html"
OUTPUT_PATH = Path(__file__).parent.parent.parent / "dist" / "index.html"

ARTICLES_PLACEHOLDER = "<!--ARTICLES-->"
SUPABASE_URL_PLACEHOLDER = "__SUPABASE_URL__"
SUPABASE_ANON_KEY_PLACEHOLDER = "__SUPABASE_ANON_KEY__"


@dataclass(frozen=True)
class Article:
    id: str
    title: str
    url: str
    domain: str
    source_type: SourceType
    cluster_id: int
    image_url: str | None = None


def _vocab(titles: Sequence[str]) -> list[str]:
    words: set[str] = set()
    for title in titles:
        words.update(title.lower().split())
    return sorted(words)


def load_feed() -> list[dict[str, str]]:
    client = get_unauthenticated_client()
    response = client.table(Link.__tablename__).select("*").order("created_at").execute()
    links = [Link.model_validate(row) for row in response.data]
    return [
        {"id": str(link.id), "title": link.title, "url": link.url, "image_url": link.image_url or ""}
        for link in links
    ]


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
                id=item["id"],
                title=item["title"],
                url=item["url"],
                domain=display_domain(item["url"]),
                source_type=classify_source(item["url"]),
                cluster_id=clusterer.clusters.index(cluster),
                image_url=item.get("image_url") or None,
            )
        )
    return articles


def _render_article(article: Article) -> str:
    link_id = escape(article.id)
    thumb = (
        f'<img class="thumb" src="{escape(article.image_url)}" alt="" loading="lazy">'
        if article.image_url
        else ""
    )
    return (
        f'      <li class="article" data-link-id="{link_id}">'
        f'<div class="swipe-bg">'
        f'<span class="tint tint-down">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L13 22h0a3.13 3.13 0 0 1-3-3.88Z"/>'
        f"</svg>"
        f"<span>Downvote</span>"
        f"</span>"
        f'<span class="tint tint-up">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/>'
        f"</svg>"
        f"<span>Upvote</span>"
        f"</span>"
        f"</div>"
        f'<div class="swipe-content">'
        f'<span class="domain">{escape(article.domain)}</span>'
        f'<div class="article-row">'
        f"{thumb}"
        f'<a href="{escape(article.url)}" target="_blank" rel="noopener noreferrer">{escape(article.title)}</a>'
        f'<span class="score">0</span>'
        f'<span class="cluster">cluster {article.cluster_id}</span>'
        f"</div>"
        f"</div>"
        f"</li>"
    )


def render(articles: Sequence[Article], *, supabase_url: str = "", supabase_anon_key: str = "") -> str:
    items = "\n".join(_render_article(article) for article in articles)
    list_html = f'    <ul class="articles">\n{items}\n    </ul>' if items else ""
    html = TEMPLATE_PATH.read_text().replace(ARTICLES_PLACEHOLDER, list_html)
    html = html.replace(SUPABASE_URL_PLACEHOLDER, json.dumps(supabase_url))
    html = html.replace(SUPABASE_ANON_KEY_PLACEHOLDER, json.dumps(supabase_anon_key))
    return html


def main() -> None:
    articles = build_articles(load_feed())
    html = render(
        articles,
        supabase_url=os.environ["SUPABASE_URL"],
        supabase_anon_key=os.environ["SUPABASE_ANON_KEY"],
    )
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(html)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
