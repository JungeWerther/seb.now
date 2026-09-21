"""Renders the seb.now homepage: real headlines from public RSS feeds, grouped
by source type (mainstream media / YouTube long-form / direct link), each
headline tagged with its topic cluster from TopicClusterer.

Same clustering path as examples/cluster_articles.py — bag_of_words_embed over
a fixed vocab, folded incrementally with vec_add — except the vocab can't be
fixed here: a word list tuned for one day's headlines means nothing against
tomorrow's, so build_vocab() derives it from whatever fetch_headlines() pulls
back from NewsFeed on each build.
"""

from __future__ import annotations

import re
import sys
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

from jinja2 import Environment, FileSystemLoader, select_autoescape

from seb_now.algebra import bag_of_words_embed, vec_add, vec_isclose
from seb_now.clustering import TopicCluster, TopicClusterer
from seb_now.constants import (
    BAG_OF_WORDS_SIMILARITY_THRESHOLD,
    DEFAULT_SITE_OUTPUT_DIR,
    FEED_FETCH_TIMEOUT_SECONDS,
    HEADLINES_PER_FEED_LIMIT,
    SITE_VOCAB_MAX_SIZE,
    SITE_VOCAB_MIN_WORD_LENGTH,
    SOURCE_TYPE_LABELS,
    NewsFeed,
    SourceType,
)
from seb_now.source_type import classify_source

TEMPLATES_DIR = Path(__file__).parent / "templates"
USER_AGENT = "seb-now-site-builder/0.1 (+https://seb.now)"
WORD_PATTERN = re.compile(r"[a-z]+")
STOPWORDS = frozenset({
    "this", "that", "with", "from", "have", "will", "says", "said",
    "after", "over", "into", "their", "what", "when", "than", "more",
    "about", "which", "they", "there", "your", "would", "could", "should",
})


def fetch_feed_items(feed_url: str) -> list[tuple[str, str]]:
    request = urllib.request.Request(feed_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=FEED_FETCH_TIMEOUT_SECONDS) as response:
        root = ElementTree.fromstring(response.read())

    items = []
    for item in root.iter("item"):
        title = item.findtext("title", "").strip()
        link = item.findtext("link", "").strip()
        if title:
            items.append((title, link))
    return items[:HEADLINES_PER_FEED_LIMIT]


def fetch_headlines() -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for feed in NewsFeed:
        try:
            items.extend(fetch_feed_items(feed.value))
        except (OSError, ElementTree.ParseError) as error:
            print(f"skipping {feed.name}: {error}", file=sys.stderr)
    return items


def build_vocab(headlines: list[str]) -> tuple[str, ...]:
    counts: Counter[str] = Counter()
    for headline in headlines:
        words = {
            word
            for word in WORD_PATTERN.findall(headline.lower())
            if len(word) >= SITE_VOCAB_MIN_WORD_LENGTH and word not in STOPWORDS
        }
        counts.update(words)
    return tuple(word for word, _ in counts.most_common(SITE_VOCAB_MAX_SIZE))


def cluster_headlines(headlines: list[str]) -> tuple[list[TopicCluster], list[int]]:
    """Clusters and, aligned to `headlines`, each headline's cluster index."""
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(build_vocab(headlines)),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=BAG_OF_WORDS_SIMILARITY_THRESHOLD,
    )
    cluster_ids = []
    for headline in headlines:
        cluster = clusterer.add_article(headline)
        cluster_ids.append(clusterer.clusters.index(cluster))
    return clusterer.clusters, cluster_ids


@dataclass(frozen=True)
class Article:
    title: str
    url: str
    source_type: SourceType
    cluster_id: int


def build_articles(items: list[tuple[str, str]]) -> list[Article]:
    titles = [title for title, _ in items]
    links = dict(items)
    _, cluster_ids = cluster_headlines(titles)

    return [
        Article(
            title=title,
            url=links.get(title, ""),
            source_type=classify_source(links.get(title, "")),
            cluster_id=cluster_id,
        )
        for title, cluster_id in zip(titles, cluster_ids)
    ]


def group_by_source_type(articles: list[Article]) -> dict[SourceType, list[Article]]:
    groups: dict[SourceType, list[Article]] = {source_type: [] for source_type in SourceType}
    for article in articles:
        groups[article.source_type].append(article)
    return groups


def group_by_cluster(articles: list[Article]) -> list[tuple[int, list[Article]]]:
    """Sub-groups a source type's articles by topic cluster id, cluster ids ascending."""
    by_cluster: dict[int, list[Article]] = {}
    for article in articles:
        by_cluster.setdefault(article.cluster_id, []).append(article)
    return sorted(by_cluster.items())


def render_site(output_dir: Path) -> None:
    articles = build_articles(fetch_headlines())
    groups = group_by_source_type(articles)

    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("index.html")
    html = template.render(
        groups=[
            (SOURCE_TYPE_LABELS[source_type], group_by_cluster(groups[source_type]))
            for source_type in SourceType
            if groups[source_type]
        ],
        sources=list(NewsFeed.__members__),
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "index.html").write_text(html)


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(DEFAULT_SITE_OUTPUT_DIR)
    render_site(target)
    print(f"wrote {target / 'index.html'}")


if __name__ == "__main__":
    main()
