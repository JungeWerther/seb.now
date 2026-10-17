"""Render index.html: a flat list of articles, each tagged with its top topics.

Each article's tag button opens its own page (seb.now/p/<id>): the page script
shows the link with all its topics and entities, and its related links.

Feed: the `links` table in Supabase (title + url per row), read with the
public anon client, with each link's `link_topics` and `link_entities` labels
embedded. Each article shows its ARTICLE_TOPIC_CHIPS highest-p topics as chips
on its domain line and its ARTICLE_ENTITY_CHIPS highest-p entities below the
post, each a link to its page (seb.now/t/<topic path>, seb.now/e/<id>). Only the
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
from functools import reduce
from html import escape
from pathlib import Path
from typing import Mapping, NamedTuple, NotRequired, Sequence, TypedDict

from seb_now.constants import (
    ARTICLE_ENTITY_CHIPS,
    ARTICLE_TOPIC_CHIPS,
    FAVICON_URL_TEMPLATE,
    FIND_ENTITY_SOURCES_PROMPT,
    FIND_SOURCES_PROMPT,
    FIND_SOURCES_URL_TEMPLATE,
    FEED_PAGE_SIZE,
    FEED_SKELETON_ROWS,
    REPLY_ICON_SIZE,
    SCORE_ICON_SIZE,
    SOURCE_FOUND_IN,
    SUPABASE_JS_MODULE_URL,
    SWIPE_ICON_SIZE,
    TEMPLATE_ARTICLE_BLANK,
    SourceType,
)
from seb_now.auth import get_unauthenticated_client
from seb_now.consent import write_consent
from seb_now.domain.models import DomainSourceType, Entity, Link, LinkEntity, LinkTopic, Topic
from seb_now.posts import load_posts, write_posts
from seb_now.sanitize import page_csp, safe_http_url, script_json
from seb_now.source_type import classify_source, display_domain, favicon_host

TEMPLATES_DIR = Path(__file__).parent / "templates"
TEMPLATE_PATH = TEMPLATES_DIR / "index.html"
# Compiled from frontend/src/filter.ts by `npm run build` in frontend/; CI
# fails if it's out of date with its source.
FILTER_JS_PATH = TEMPLATES_DIR / "filter.js"
OUTPUT_PATH = Path(__file__).parent.parent.parent / "dist" / "index.html"

ARTICLES_PLACEHOLDER = "<!--ARTICLES-->"
SUPABASE_URL_PLACEHOLDER = "__SUPABASE_URL__"
SUPABASE_ANON_KEY_PLACEHOLDER = "__SUPABASE_ANON_KEY__"
FEED_PAGE_SIZE_PLACEHOLDER = "__FEED_PAGE_SIZE__"
ARTICLE_TOPIC_CHIPS_PLACEHOLDER = "__ARTICLE_TOPIC_CHIPS__"
ARTICLE_ENTITY_CHIPS_PLACEHOLDER = "__ARTICLE_ENTITY_CHIPS__"
FAVICON_URL_TEMPLATE_PLACEHOLDER = "__FAVICON_URL_TEMPLATE__"
FIND_SOURCES_URL_TEMPLATE_PLACEHOLDER = "__FIND_SOURCES_URL_TEMPLATE__"
FIND_SOURCES_PROMPT_PLACEHOLDER = "__FIND_SOURCES_PROMPT__"
FIND_ENTITY_SOURCES_PROMPT_PLACEHOLDER = "__FIND_ENTITY_SOURCES_PROMPT__"
SUPABASE_JS_MODULE_URL_PLACEHOLDER = "__SUPABASE_JS_MODULE_URL__"
CSP_PLACEHOLDER = "__CONTENT_SECURITY_POLICY__"
FILTER_JS_PLACEHOLDER = "__FILTER_JS__"

FEED_COLUMNS = "id, title, url, image_url, author, created_at"


# Lucide icon bodies (24x24 viewBox), drawn by _lucide at each use's size.
TRASH_ICON = (
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>'
    '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'
    '<line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
)
THUMBS_UP_ICON = (
    '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 '
    '1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/>'
)
MESSAGE_ICON = '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'


def _lucide(body: str, size: int) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f"{body}</svg>"
    )


class Chip(NamedTuple):
    id: str
    name: str


@dataclass(frozen=True)
class Article:
    id: str
    title: str
    url: str
    domain: str
    source_type: SourceType
    topics: tuple[Chip, ...] = ()
    entities: tuple[Chip, ...] = ()
    image_url: str | None = None
    created_at: str = ""
    # The source entity it came from (a channel, account or feed), whose page
    # the domain line links to.
    source: Chip | None = None


class FeedItem(TypedDict):
    id: str
    title: str
    url: str
    image_url: NotRequired[str]
    author: NotRequired[str]
    topics: NotRequired[list[Chip]]
    entities: NotRequired[list[Chip]]
    source: NotRequired[Chip | None]
    created_at: NotRequired[str]


# The page script clones this and fills it in per fetched link, so it carries
# one topic chip, one entity chip and a cover for the script to fill or drop.
TEMPLATE_ARTICLE = Article(
    id=TEMPLATE_ARTICLE_BLANK,
    title=TEMPLATE_ARTICLE_BLANK,
    url=TEMPLATE_ARTICLE_BLANK,
    domain=TEMPLATE_ARTICLE_BLANK,
    source_type=SourceType.DIRECT_LINK,
    topics=(Chip(TEMPLATE_ARTICLE_BLANK, TEMPLATE_ARTICLE_BLANK),),
    entities=(Chip(TEMPLATE_ARTICLE_BLANK, TEMPLATE_ARTICLE_BLANK),),
    image_url=TEMPLATE_ARTICLE_BLANK,
    source=Chip(TEMPLATE_ARTICLE_BLANK, TEMPLATE_ARTICLE_BLANK),
)


def _top_labels(labels: Sequence[dict], key: str, count: int) -> list[dict]:
    ranked = sorted((label for label in labels if label[key]), key=lambda label: (-label["p"], label[key]["name"]))
    return [label[key] for label in ranked[:count]]


def _top_topics(link_topics: Sequence[dict]) -> list[Chip]:
    return [
        Chip(topic["id"], topic["name"]) for topic in _top_labels(link_topics, Topic.__tablename__, ARTICLE_TOPIC_CHIPS)
    ]


def _top_entities(link_entities: Sequence[dict]) -> list[Chip]:
    """The highest-p entities the link mentions; its source isn't a mention."""
    mentions = [label for label in link_entities if label.get("found_in") != SOURCE_FOUND_IN]
    return [
        Chip(entity["id"], entity["name"])
        for entity in _top_labels(mentions, Entity.__tablename__, ARTICLE_ENTITY_CHIPS)
    ]


def _source(link_entities: Sequence[dict]) -> Chip | None:
    """The source entity the link is tagged with (found_in 'source'), if any."""
    return next(
        (
            Chip(entity["id"], entity["name"])
            for label in link_entities
            if label.get("found_in") == SOURCE_FOUND_IN and (entity := label.get(Entity.__tablename__))
        ),
        None,
    )


def _feed_item(row: dict) -> FeedItem | None:
    """A links row as a feed item, or None when its url isn't http(s)."""
    url = safe_http_url(row["url"])
    if url is None:
        return None
    entities = row.get(LinkEntity.__tablename__) or []
    return {
        "id": row["id"],
        "title": row["title"],
        "url": url,
        "image_url": safe_http_url(row["image_url"]) or "",
        "author": row.get("author") or "",
        "topics": _top_topics(row[LinkTopic.__tablename__]),
        "entities": _top_entities(entities),
        "source": _source(entities),
        # Kept as PostgREST's own string so the page's pagination
        # cursor round-trips it exactly (microseconds included).
        "created_at": row["created_at"],
    }


def load_feed() -> list[FeedItem]:
    client = get_unauthenticated_client()
    response = (
        client.table(Link.__tablename__)
        .select(
            f"{FEED_COLUMNS}, {LinkTopic.__tablename__}(p, {Topic.__tablename__}(id, name)), "
            f"{LinkEntity.__tablename__}(p, found_in, {Entity.__tablename__}(id, name))"
        )
        .order("created_at", desc=True)
        .order("id", desc=True)
        .limit(FEED_PAGE_SIZE)
        .execute()
    )
    return [item for row in response.data if (item := _feed_item(row)) is not None]


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
            entities=tuple(item.get("entities", ())),
            image_url=item.get("image_url") or None,
            source=item.get("source"),
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
        + "".join(f'<a class="topic" href="/t/{escape(topic.id)}">{escape(topic.name)}</a>' for topic in article.topics)
        + "</span>"
        if article.topics
        else ""
    )
    entities = (
        '<span class="entities">'
        + "".join(
            f'<a class="entity" href="/e/{escape(entity.id)}">{escape(entity.name)}</a>' for entity in article.entities
        )
        + "</span>"
        if article.entities
        else ""
    )
    # The domain line links to the source's page when the link has one; the
    # template's is an anchor too, whose href the page script sets or drops.
    domain = (
        f'<a class="domain" href="/e/{escape(article.source.id)}">{escape(article.domain)}</a>'
        if article.source is not None
        else f'<span class="domain">{escape(article.domain)}</span>'
    )
    return (
        f'      <li class="article" data-link-id="{link_id}" data-created-at="{escape(article.created_at)}">'
        f'<div class="swipe-content">'
        f"{favicon}"
        f'<div class="card-body">'
        f'<div class="meta">'
        f"{domain}"
        f'<time class="posted" datetime="{escape(article.created_at)}">'
        f"{escape(posted_label(article.created_at, datetime.now(UTC).date()))}</time>"
        f"{topics}"
        f"</div>"
        f'<div class="post-swipe">'
        f'<div class="swipe-bg">'
        f'<span class="tint tint-down">'
        f"{_lucide(TRASH_ICON, SWIPE_ICON_SIZE)}"
        f"<span>Not interested</span>"
        f"</span>"
        f'<span class="tint tint-up">'
        f"{_lucide(THUMBS_UP_ICON, SWIPE_ICON_SIZE)}"
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
        f"{entities}"
        f'<span class="score">'
        f"{_lucide(THUMBS_UP_ICON, SCORE_ICON_SIZE)}"
        f'<span class="score-value">0</span>'
        f"</span>"
        f'<span class="reply-count" hidden></span>'
        f'<button type="button" class="reply-btn" aria-label="Reply">'
        f"{_lucide(MESSAGE_ICON, REPLY_ICON_SIZE)}"
        f"</button>"
        f"</div>"
        f'<ol class="replies" hidden></ol>'
        f"</div>"
        f"</div>"
        f"</li>"
    )


def _render_skeletons() -> str:
    row = (
        '      <li class="skeleton"><div class="swipe-content">'
        '<span class="favicon"></span>'
        '<div class="card-body">'
        '<div class="meta"><span class="bone bone-domain"></span></div>'
        '<div class="post"><span class="bone"></span><span class="bone bone-short"></span>'
        '<span class="bone bone-cover"></span></div>'
        "</div></div></li>"
    )
    return "".join(f"\n{row}" for _ in range(FEED_SKELETON_ROWS))


def compiled_script(path: Path) -> str:
    """A compiled frontend script to inline into the page's module script.

    It's our own code, not data, but it must still not be able to close the
    `<script>` it lands in.
    """
    code = path.read_text()
    if "</script" in code.lower():
        raise ValueError(f"{path} contains </script and can't be inlined")
    return code


def render(articles: Sequence[Article], *, supabase_url: str = "", supabase_anon_key: str = "") -> str:
    items = "".join(f"\n{_render_article(article)}" for article in articles)
    list_html = (
        f'    <ul class="articles">{items}\n    </ul>\n'
        f'    <ul class="link-list" id="feed-skeletons" aria-hidden="true" hidden>{_render_skeletons()}\n    </ul>\n'
        f'    <div id="feed-sentinel" aria-hidden="true"></div>\n'
        f'    <template id="article-template">\n{_render_article(TEMPLATE_ARTICLE)}\n    </template>'
    )
    substitutions = {
        ARTICLES_PLACEHOLDER: list_html,
        FILTER_JS_PLACEHOLDER: compiled_script(FILTER_JS_PATH),
        SUPABASE_URL_PLACEHOLDER: script_json(supabase_url),
        SUPABASE_ANON_KEY_PLACEHOLDER: script_json(supabase_anon_key),
        FEED_PAGE_SIZE_PLACEHOLDER: script_json(FEED_PAGE_SIZE),
        ARTICLE_TOPIC_CHIPS_PLACEHOLDER: script_json(ARTICLE_TOPIC_CHIPS),
        ARTICLE_ENTITY_CHIPS_PLACEHOLDER: script_json(ARTICLE_ENTITY_CHIPS),
        FAVICON_URL_TEMPLATE_PLACEHOLDER: script_json(FAVICON_URL_TEMPLATE),
        FIND_SOURCES_URL_TEMPLATE_PLACEHOLDER: script_json(FIND_SOURCES_URL_TEMPLATE),
        FIND_SOURCES_PROMPT_PLACEHOLDER: script_json(FIND_SOURCES_PROMPT),
        FIND_ENTITY_SOURCES_PROMPT_PLACEHOLDER: script_json(FIND_ENTITY_SOURCES_PROMPT),
        SUPABASE_JS_MODULE_URL_PLACEHOLDER: script_json(SUPABASE_JS_MODULE_URL),
    }
    # The CSP hashes the finished script, so it's filled in last.
    html = reduce(lambda page, sub: page.replace(*sub), substitutions.items(), TEMPLATE_PATH.read_text())
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
