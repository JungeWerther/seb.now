"""Render index.html: a flat list of articles, each tagged with its top topics.

Feed: the `links` table in Supabase (title + url per row), read with the
public anon client, with each link's `link_topics` labels embedded. Each
article shows its ARTICLE_TOPIC_CHIPS highest-p topics as chips. Only the
newest FEED_PAGE_SIZE links are pre-rendered; the page script fetches the
rest (and any newer than the build) as you scroll, filling the
`#article-template` markup emitted here so both paths share one layout.
classify_source still tags each article's SourceType (mainstream media /
YouTube long-form / direct link) for future filtering, but the page no
longer groups or headers by it - each article shows its own domain instead.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, date, datetime
from html import escape
from pathlib import Path
from typing import Mapping, NotRequired, Sequence, TypedDict

from seb_now.constants import (
    ARTICLE_TOPIC_CHIPS,
    FAVICON_URL_TEMPLATE,
    FEED_PAGE_SIZE,
    SUPABASE_JS_MODULE_URL,
    TEMPLATE_ARTICLE_BLANK,
    SourceType,
)
from seb_now.auth import get_unauthenticated_client
from seb_now.consent import write_consent
from seb_now.domain.models import DomainSourceType, Link, LinkTopic, Topic
from seb_now.posts import load_posts, write_posts
from seb_now.sanitize import page_csp, safe_http_url, script_json
from seb_now.source_type import classify_source, display_domain, favicon_host

TEMPLATES_DIR = Path(__file__).parent / "templates"
TEMPLATE_PATH = TEMPLATES_DIR / "index.html"
OUTPUT_PATH = Path(__file__).parent.parent.parent / "dist" / "index.html"

ARTICLES_PLACEHOLDER = "<!--ARTICLES-->"
SUPABASE_URL_PLACEHOLDER = "__SUPABASE_URL__"
SUPABASE_ANON_KEY_PLACEHOLDER = "__SUPABASE_ANON_KEY__"
FEED_PAGE_SIZE_PLACEHOLDER = "__FEED_PAGE_SIZE__"
ARTICLE_TOPIC_CHIPS_PLACEHOLDER = "__ARTICLE_TOPIC_CHIPS__"
FAVICON_URL_TEMPLATE_PLACEHOLDER = "__FAVICON_URL_TEMPLATE__"
SUPABASE_JS_MODULE_URL_PLACEHOLDER = "__SUPABASE_JS_MODULE_URL__"
CSP_PLACEHOLDER = "__CONTENT_SECURITY_POLICY__"

FEED_COLUMNS = "id, title, url, image_url, author, created_at"


@dataclass(frozen=True)
class Article:
    id: str
    title: str
    url: str
    domain: str
    source_type: SourceType
    topics: tuple[str, ...] = ()
    image_url: str | None = None
    created_at: str = ""


class FeedItem(TypedDict):
    id: str
    title: str
    url: str
    image_url: NotRequired[str]
    author: NotRequired[str]
    topics: NotRequired[list[str]]
    created_at: NotRequired[str]


# The page script clones this and fills it in per fetched link, so it carries
# one topic chip and a cover for the script to fill or drop.
TEMPLATE_ARTICLE = Article(
    id=TEMPLATE_ARTICLE_BLANK,
    title=TEMPLATE_ARTICLE_BLANK,
    url=TEMPLATE_ARTICLE_BLANK,
    domain=TEMPLATE_ARTICLE_BLANK,
    source_type=SourceType.DIRECT_LINK,
    topics=(TEMPLATE_ARTICLE_BLANK,),
    image_url=TEMPLATE_ARTICLE_BLANK,
)


def _top_topic_names(link_topics: Sequence[dict]) -> list[str]:
    ranked = sorted(link_topics, key=lambda lt: (-lt["p"], lt["topics"]["name"]))
    return [lt["topics"]["name"] for lt in ranked[:ARTICLE_TOPIC_CHIPS]]


def load_feed() -> list[FeedItem]:
    client = get_unauthenticated_client()
    response = (
        client.table(Link.__tablename__)
        .select(f"{FEED_COLUMNS}, {LinkTopic.__tablename__}(p, {Topic.__tablename__}(name))")
        .order("created_at", desc=True)
        .order("id", desc=True)
        .limit(FEED_PAGE_SIZE)
        .execute()
    )
    feed: list[FeedItem] = []
    for row in response.data:
        url = safe_http_url(row["url"])
        if url is None:
            continue
        feed.append(
            {
                "id": row["id"],
                "title": row["title"],
                "url": url,
                "image_url": safe_http_url(row["image_url"]) or "",
                "author": row.get("author") or "",
                "topics": _top_topic_names(row[LinkTopic.__tablename__]),
                # Kept as PostgREST's own string so the page's pagination
                # cursor round-trips it exactly (microseconds included).
                "created_at": row["created_at"],
            }
        )
    return feed


def load_domain_source_types() -> dict[str, SourceType]:
    client = get_unauthenticated_client()
    response = client.table(DomainSourceType.__tablename__).select("domain, source_type").execute()
    return {row["domain"]: SourceType(row["source_type"]) for row in response.data}


def posted_label(created_at: str, today: date) -> str:
    """The post's date on its domain line ("Sep 27", with the year once it's
    not this year's), in UTC. Same as the page script's postedLabel."""
    try:
        posted = datetime.fromisoformat(created_at).astimezone(UTC).date()
    except ValueError:
        return ""
    label = f"{posted:%b} {posted.day}"
    return label if posted.year == today.year else f"{label}, {posted.year}"


def domain_with_author(domain: str, author: str) -> str:
    """The domain line: a handle stands in for the domain ("@Channel5YouTube";
    the favicon still shows the platform), a display name follows it
    ("youtube · Name"). Same as the page script's domainWithAuthor."""
    if not author:
        return domain
    return author if author.startswith("@") else f"{domain} · {author}"


def build_articles(
    feed: Sequence[FeedItem], domain_source_types: Mapping[str, SourceType]
) -> list[Article]:
    return [
        Article(
            id=item["id"],
            title=item["title"],
            url=item["url"],
            domain=domain_with_author(display_domain(item["url"]), item.get("author", "")),
            source_type=classify_source(item["url"], domain_source_types),
            topics=tuple(item.get("topics", ())),
            image_url=item.get("image_url") or None,
            created_at=item.get("created_at", ""),
        )
        for item in feed
    ]


def _render_article(article: Article) -> str:
    link_id = escape(article.id)
    url = escape(article.url)
    host = favicon_host(article.url)
    favicon = (
        f'<span class="favicon" data-letter="{escape(host[:1].upper())}" aria-hidden="true">'
        f'<img src="{escape(FAVICON_URL_TEMPLATE.format(host=host))}" alt="" loading="lazy"></span>'
    )
    cover = (
        f'<a class="cover-link" href="{url}" target="_blank" rel="noopener noreferrer" tabindex="-1">'
        f'<img class="cover" src="{escape(article.image_url)}" alt="" loading="lazy"></a>'
        if article.image_url is not None
        else ""
    )
    topics = (
        '<span class="topics">'
        + "".join(f'<span class="topic">{escape(name)}</span>' for name in article.topics)
        + "</span>"
        if article.topics
        else ""
    )
    return (
        f'      <li class="article" data-link-id="{link_id}" data-created-at="{escape(article.created_at)}">'
        f'<div class="swipe-content">'
        f"{favicon}"
        f'<div class="card-body">'
        f'<div class="meta">'
        f'<span class="domain">{escape(article.domain)}</span>'
        f'<time class="posted" datetime="{escape(article.created_at)}">'
        f"{escape(posted_label(article.created_at, datetime.now(UTC).date()))}</time>"
        f"{topics}"
        f"</div>"
        f'<div class="post-swipe">'
        f'<div class="swipe-bg">'
        f'<span class="tint tint-down">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>'
        f'<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'
        f'<line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
        f"</svg>"
        f"<span>Not interested</span>"
        f"</span>"
        f'<span class="tint tint-up">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/>'
        f"</svg>"
        f"<span>Upvote</span>"
        f"</span>"
        f"</div>"
        f'<div class="post">'
        f'<div class="article-row">'
        f'<a href="{url}" target="_blank" rel="noopener noreferrer">{escape(article.title)}</a>'
        f"</div>"
        f"{cover}"
        f"</div>"
        f"</div>"
        f'<div class="post-footer">'
        f'<span class="score">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/>'
        f"</svg>"
        f'<span class="score-value">0</span>'
        f"</span>"
        f'<span class="reply-count" hidden></span>'
        f'<button type="button" class="reply-btn" aria-label="Reply">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'
        f"</svg>"
        f"</button>"
        f"</div>"
        f'<ol class="replies" hidden></ol>'
        f"</div>"
        f"</div>"
        f"</li>"
    )


def render(articles: Sequence[Article], *, supabase_url: str = "", supabase_anon_key: str = "") -> str:
    items = "".join(f"\n{_render_article(article)}" for article in articles)
    list_html = (
        f'    <ul class="articles">{items}\n    </ul>\n'
        f'    <div id="feed-sentinel" aria-hidden="true"></div>\n'
        f'    <template id="article-template">\n{_render_article(TEMPLATE_ARTICLE)}\n    </template>'
    )
    html = TEMPLATE_PATH.read_text().replace(ARTICLES_PLACEHOLDER, list_html)
    html = html.replace(SUPABASE_URL_PLACEHOLDER, script_json(supabase_url))
    html = html.replace(SUPABASE_ANON_KEY_PLACEHOLDER, script_json(supabase_anon_key))
    html = html.replace(FEED_PAGE_SIZE_PLACEHOLDER, script_json(FEED_PAGE_SIZE))
    html = html.replace(ARTICLE_TOPIC_CHIPS_PLACEHOLDER, script_json(ARTICLE_TOPIC_CHIPS))
    html = html.replace(FAVICON_URL_TEMPLATE_PLACEHOLDER, script_json(FAVICON_URL_TEMPLATE))
    html = html.replace(SUPABASE_JS_MODULE_URL_PLACEHOLDER, script_json(SUPABASE_JS_MODULE_URL))
    return html.replace(CSP_PLACEHOLDER, escape(page_csp(html, supabase_url)))


def main() -> None:
    supabase_url = os.environ["SUPABASE_URL"]
    supabase_anon_key = os.environ["SUPABASE_ANON_KEY"]
    articles = build_articles(load_feed(), load_domain_source_types())
    html = render(articles, supabase_url=supabase_url, supabase_anon_key=supabase_anon_key)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(html)
    print(f"wrote {OUTPUT_PATH}")

    posts = load_posts()
    write_posts(posts, OUTPUT_PATH.parent)
    print(f"wrote {len(posts)} post(s) under {OUTPUT_PATH.parent / 'posts'}")

    consent_path = write_consent(OUTPUT_PATH.parent, supabase_url=supabase_url, supabase_anon_key=supabase_anon_key)
    print(f"wrote {consent_path}")


if __name__ == "__main__":
    main()
