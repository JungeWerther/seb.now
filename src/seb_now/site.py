"""Renders the seb.now homepage: real headlines from public RSS feeds, grouped
into topics by TopicClusterer.

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
    NewsFeed,
)

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


def cluster_headlines(headlines: list[str]) -> list[TopicCluster]:
    clusterer = TopicClusterer(
        embed=bag_of_words_embed(build_vocab(headlines)),
        combine_emb=vec_add,
        is_close=vec_isclose,
        similarity_threshold=BAG_OF_WORDS_SIMILARITY_THRESHOLD,
    )
    for headline in headlines:
        clusterer.add_article(headline)
    return clusterer.clusters


def render_site(output_dir: Path) -> None:
    items = fetch_headlines()
    titles = [title for title, _ in items]
    links = dict(items)

    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("index.html")
    html = template.render(
        clusters=cluster_headlines(titles),
        links=links,
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
