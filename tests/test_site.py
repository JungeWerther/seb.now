import base64
import hashlib
import math
import re
from html import unescape
from pathlib import Path
from uuid import uuid4

import pytest

from seb_now import site
from seb_now.constants import (
    ARTICLE_ENTITY_CHIPS,
    ARTICLE_TOPIC_CHIPS,
    FAVICON_URL_TEMPLATE,
    FEED_PAGE_SIZE,
    FEED_SKELETON_ROWS,
    FIND_ENTITY_SOURCES_PROMPT,
    FIND_SOURCES_URL_TEMPLATE,
    SUPABASE_JS_URL,
    SourceType,
)
from seb_now.site import Article, Chip, FeedRow, _top_entities, _top_topics, build_articles, render

DOMAIN_SOURCE_TYPES = {
    "nytimes.com": SourceType.MAINSTREAM_MEDIA,
    "youtube.com": SourceType.YOUTUBE_LONGFORM,
}


def _row(**overrides: object) -> FeedRow:
    fields: FeedRow = {
        "id": str(uuid4()),
        "title": "A link",
        "url": "https://example.com/a",
        "image_url": None,
        "author": None,
        "created_at": "2026-01-01T00:00:00+00:00",
        "link_topics": [],
        "link_entities": [],
    }
    return {**fields, **overrides}


FEED_FIXTURE = [
    _row(
        id="11111111-1111-1111-1111-111111111111",
        title="Fed signals rate cut as inflation cools",
        url="https://www.nytimes.com/a",
    ),
    _row(
        id="22222222-2222-2222-2222-222222222222",
        title="Fed chair explains the rate decision in full",
        url="https://www.youtube.com/watch?v=a",
    ),
    _row(
        id="33333333-3333-3333-3333-333333333333",
        title="My take on the Fed's rate cut",
        url="https://sebswrites.example.com/posts/a",
    ),
]


def _article_list(html: str) -> str:
    """The pre-rendered <ul class="articles">, without the #article-template copy."""
    start = html.index('<ul class="articles">')
    return html[start : html.index("</ul>", start)]


def test_build_articles_classifies_source_type() -> None:
    articles = build_articles(FEED_FIXTURE, DOMAIN_SOURCE_TYPES)

    source_types = {article.source_type for article in articles}
    assert source_types == {SourceType.MAINSTREAM_MEDIA, SourceType.YOUTUBE_LONGFORM, SourceType.DIRECT_LINK}


def test_build_articles_computes_display_domain() -> None:
    articles = build_articles(FEED_FIXTURE, DOMAIN_SOURCE_TYPES)

    domains = {article.id: article.domain for article in articles}
    assert domains["11111111-1111-1111-1111-111111111111"] == "nytimes"
    assert domains["22222222-2222-2222-2222-222222222222"] == "youtube"
    assert domains["33333333-3333-3333-3333-333333333333"] == "sebswrites.example"


def test_render_is_a_flat_list_with_no_group_headers() -> None:
    articles = [
        Article(
            id="a1",
            title="Blog post",
            url="https://blog.example.com/a",
            domain="blog.example",
            source_type=SourceType.DIRECT_LINK,
        ),
        Article(
            id="a2",
            title="Wire story",
            url="https://www.reuters.com/a",
            domain="reuters",
            source_type=SourceType.MAINSTREAM_MEDIA,
        ),
    ]

    html = render(articles)

    assert "Blog post" in html
    assert "Wire story" in html
    assert "Mainstream Media" not in html
    assert "Direct Link" not in html
    assert "<h2>" not in html
    assert _article_list(html).count('li class="article"') == 2


def test_render_includes_swipeable_article_with_link_id_and_domain() -> None:
    articles = [
        Article(
            id="a1",
            title="Wire story",
            url="https://www.reuters.com/a",
            domain="reuters",
            source_type=SourceType.MAINSTREAM_MEDIA,
        )
    ]

    html = render(articles)

    assert 'li class="article" data-link-id="a1"' in html
    assert 'class="swipe-bg"' in html
    assert 'class="swipe-content"' in html
    assert 'class="score"' in html
    assert '<span class="domain">reuters</span>' in html


def test_render_shows_clickable_cover_image_below_title_when_present() -> None:
    with_cover = Article(
        id="a1",
        title="Has cover",
        url="https://example.com/a",
        domain="example",
        source_type=SourceType.DIRECT_LINK,
        image_url="https://example.com/cover.jpg",
    )
    without_cover = Article(
        id="a2",
        title="No cover",
        url="https://example.com/b",
        domain="example",
        source_type=SourceType.DIRECT_LINK,
    )

    html = render([with_cover, without_cover])

    assert (
        '<a class="cover-link" href="https://example.com/a" target="_blank" rel="noopener noreferrer" '
        'tabindex="-1"><img class="cover" src="https://example.com/cover.jpg" alt="" loading="lazy"></a>'
    ) in html
    assert _article_list(html).count('class="cover"') == 1
    title_index = html.index(">Has cover</a>")
    cover_index = html.index('<a class="cover-link"')
    assert title_index < cover_index


def test_render_shows_favicon_column_with_letter_fallback() -> None:
    article = Article(
        id="a1",
        title="Wire story",
        url="https://www.reuters.com/a",
        domain="reuters",
        source_type=SourceType.MAINSTREAM_MEDIA,
    )

    html = render([article])

    favicon_url = FAVICON_URL_TEMPLATE.format(host="reuters.com")
    assert (
        f'<span class="favicon" data-letter="R" aria-hidden="true"><img src="{favicon_url}" alt="" loading="lazy"></span>'
        in html
    )
    assert html.index('class="favicon"') < html.index('class="card-body"')


def test_build_articles_keeps_feed_topics() -> None:
    link_topics = [
        {"p": 0.9, "topics": {"id": "ai.models", "name": "AI models"}},
        {"p": 0.7, "topics": {"id": "tech.open_source", "name": "Open source"}},
    ]
    feed = [{**FEED_FIXTURE[0], "link_topics": link_topics}, FEED_FIXTURE[1]]

    articles = build_articles(feed, DOMAIN_SOURCE_TYPES)

    assert articles[0].topics == (Chip("ai.models", "AI models"), Chip("tech.open_source", "Open source"))
    assert articles[1].topics == ()


def test_top_topics_orders_by_p_and_caps_at_chip_count() -> None:
    link_topics = [
        {"p": 0.5, "topics": {"id": "tech.big_tech", "name": "Big tech"}},
        {"p": 0.9, "topics": {"id": "ai.models", "name": "AI models"}},
        {"p": 0.7, "topics": {"id": "tech.open_source", "name": "Open source"}},
    ]

    expected = (Chip("ai.models", "AI models"), Chip("tech.open_source", "Open source"))[:ARTICLE_TOPIC_CHIPS]
    assert _top_topics(link_topics) == expected


def test_render_links_topic_chips_and_omits_them_when_untagged() -> None:
    tagged = Article(
        id="a1",
        title="Tagged",
        url="https://example.com/a",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
        topics=(Chip("ai.models", "AI models"), Chip("tech.open_source", "Open source")),
    )
    untagged = Article(
        id="a2",
        title="Untagged",
        url="https://example.com/b",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
    )

    html = render([tagged, untagged])

    assert (
        '<span class="topics"><a class="topic" href="/t/ai.models">AI models</a>'
        '<a class="topic" href="/t/tech.open_source">Open source</a></span>'
    ) in html
    assert _article_list(html).count('<span class="topics">') == 1
    assert "cluster" not in html


def test_top_entities_orders_by_p_and_caps_at_chip_count() -> None:
    link_entities = [
        {"p": 0.8, "found_in": "title", "entities": {"id": "e1", "name": "OpenAI"}},
        {"p": 1.0, "found_in": "title", "entities": {"id": "e2", "name": "Sam Altman"}},
        {"p": 0.9, "found_in": "title", "entities": {"id": "e3", "name": "Microsoft"}},
        {"p": 0.85, "found_in": "title", "entities": {"id": "e4", "name": "Anthropic"}},
        {"p": 0.95, "found_in": "title", "entities": None},
    ]

    expected = (
        Chip("e2", "Sam Altman"),
        Chip("e3", "Microsoft"),
        Chip("e4", "Anthropic"),
        Chip("e1", "OpenAI"),
    )[:ARTICLE_ENTITY_CHIPS]
    assert _top_entities(link_entities) == expected


def test_render_links_entity_chips_bottom_left_of_the_footer_and_omits_them_when_none() -> None:
    with_entities = Article(
        id="a1",
        title="Tagged",
        url="https://example.com/a",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
        entities=(Chip("e1", "OpenAI"), Chip("e2", "<b>Sam</b>")),
    )
    without = Article(
        id="a2",
        title="Untagged",
        url="https://example.com/b",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
    )

    articles = _article_list(render([with_entities, without]))

    assert (
        '<div class="post-footer"><span class="entities"><a class="entity" href="/e/e1">OpenAI</a>'
        '<a class="entity" href="/e/e2">&lt;b&gt;Sam&lt;/b&gt;</a></span><span class="score">'
    ) in articles
    assert articles.count('<span class="entities">') == 1


def test_render_includes_hidden_skeleton_rows_after_the_feed() -> None:
    html = render([])

    start = html.index('<ul class="link-list" id="feed-skeletons" aria-hidden="true" hidden>')
    skeletons = html[start : html.index("</ul>", start)]
    assert skeletons.count('<li class="skeleton">') == FEED_SKELETON_ROWS
    assert html.index('<ul class="articles">') < start < html.index('id="feed-sentinel"')
    script = html[html.index('<script type="module">') :]
    assert "feedSkeletons.hidden = !feed.loading || feed.replacing;" in script


def test_related_links_look_like_the_feed_with_shared_chips_highlighted() -> None:
    html = render([])

    assert "Shares " not in html
    assert "related-why" not in html
    script = html[html.index('<script type="module">') :]
    assert "new Set(r.shared_entities)" in script and "new Set(r.shared_topics)" in script
    assert 'el.classList.toggle("shared", shared.has(name))' in script
    # Opening a link already rendered reuses its row instead of fetching it.
    assert "let row = linkRows.get(id);" in script


def test_render_gives_each_article_a_reply_button_and_empty_reply_list() -> None:
    article = Article(
        id="a1",
        title="Wire story",
        url="https://www.reuters.com/a",
        domain="reuters",
        source_type=SourceType.MAINSTREAM_MEDIA,
    )

    html = render([article])

    assert '<button type="button" class="reply-btn" aria-label="Reply">' in html
    assert '<ol class="replies" hidden></ol>' in html
    assert html.index('class="reply-btn"') < html.index('class="replies"')


def test_link_page_focuses_a_tapped_post_above_its_related_links() -> None:
    html = render([])

    focus = html[
        html.index('<section id="focus" hidden>') : html.index("</section>", html.index('<section id="focus"'))
    ]
    for list_id in ("focus-entities", "focus-topics"):
        assert f'id="{list_id}"' in focus
        assert f'id="{list_id}-title" hidden' in focus
    assert html.index('<section id="focus"') < html.index('<ul class="articles">')
    script = html[html.index('<script type="module">') :]
    assert 'rpc("related_feed"' in script
    assert "page_offset: offset" in script
    assert "link_entities(p, found_in, entities(id, name, kind, kind_path))" in script
    assert "history.pushState" in script and "`/p/${id}`" in script
    assert "focusLink(li.dataset.linkId, { from: li })" in script
    assert "setupLinkPage();" in script
    assert 'class="details-btn"' not in html
    # The feed is found with querySelector("ul.articles"), so no other list may
    # carry that class.
    assert html.count('<ul class="articles') == 1


def test_focused_post_sits_on_a_black_band_that_fades_to_the_page() -> None:
    html = render([])

    assert "@property --focus-dark" in html
    assert "linear-gradient(var(--focus-shade) var(--focus-end), var(--bg) calc(var(--focus-end) + 100vh))" in html
    script = html[html.index('<script type="module">') :]
    assert 'setProperty("--focus-end"' in script
    # A swipe or scroll that started on the card must not also open it.
    assert "if (!moved) return;" in script


def test_render_includes_reply_composer_in_the_dock() -> None:
    html = render([])

    dock = html[html.index('id="search-dock"') :]
    assert 'id="reply-composer" hidden' in dock
    assert 'id="reply-input"' in dock
    assert 'id="reply-send"' in dock
    assert 'id="reply-cancel"' in dock
    assert "setupReplies" in html


def test_template_never_assigns_non_literal_html() -> None:
    # Replies are untrusted user text; they must reach the DOM via textContent.
    # Any innerHTML/outerHTML/insertAdjacentHTML fed by a non-literal is an XSS
    # vector, so only single-quoted/double-quoted string literals are allowed.
    html = render([])
    script = html[html.index('<script type="module">') :]
    for match in re.finditer(r"\.(innerHTML|outerHTML)\s*=\s*(.)", script):
        assert match.group(2) in "'\"", (
            f"non-literal {match.group(1)} assignment: {script[match.start() : match.start() + 80]}"
        )
    assert "insertAdjacentHTML" not in script
    assert "document.write" not in script


def test_swipe_area_wraps_only_the_post_box() -> None:
    article = Article(
        id="a1",
        title="Wire story",
        url="https://www.reuters.com/a",
        domain="reuters",
        source_type=SourceType.MAINSTREAM_MEDIA,
    )

    html = render([article])

    swipe = html.index('<div class="post-swipe">')
    assert html.index('class="meta"') < swipe
    assert swipe < html.index('<div class="swipe-bg">') < html.index('<div class="post">')
    assert html.index('<ol class="replies"') > html.index('class="reply-btn"')


def test_render_includes_menu_bubbles_and_their_overlays() -> None:
    html = render([])

    assert 'id="menu-btn"' in html
    start = html.index('<ul id="menu-bubbles">')
    menu = html[start : html.index("</ul>", start)]
    for overlay, label in (
        ("taste-overlay", "My Algorithm"),
        ("profile-overlay", "My Profile"),
        ("appearance-overlay", "Appearance"),
    ):
        assert f'data-overlay="{overlay}"' in menu
        assert label in menu
        assert f'<dialog id="{overlay}" class="overlay"' in html


def test_render_includes_svg_wordmark() -> None:
    html = render([])

    assert '<h1 class="brand">' in html
    assert '<svg class="wordmark"' in html
    assert "tagline" not in html
    assert 'aria-label="seb.now"' in html
    assert ">seb<" in html
    assert ">now<" in html


def test_render_includes_live_search_bar() -> None:
    html = render([])

    assert 'id="search-input"' in html
    assert 'type="search"' in html
    assert 'id="search-empty"' in html
    assert "setupSearch" in html
    assert 'id="search-bar"' in html
    assert 'id="search-dock"' in html


def test_render_includes_search_clear_button() -> None:
    html = render([])

    assert 'id="search-clear"' in html
    assert 'aria-label="Clear search"' in html


def test_render_pins_fixed_bars_to_visual_viewport() -> None:
    html = render([])

    assert "setupViewportPinning" in html
    assert "visualViewport" in html


def test_render_persists_search_query_across_reloads() -> None:
    html = render([])

    assert "localStorage" in html
    assert "SEARCH_QUERY_STORAGE_KEY" in html


def test_render_injects_supabase_config() -> None:
    html = render([], supabase_url="https://example.supabase.co", supabase_anon_key="test-anon-key")

    assert "https://example.supabase.co" in html
    assert "test-anon-key" in html
    assert "__SUPABASE_URL__" not in html
    assert "__SUPABASE_ANON_KEY__" not in html


def test_render_carries_each_articles_created_at_for_the_pagination_cursor() -> None:
    article = Article(
        id="a1",
        title="Wire story",
        url="https://www.reuters.com/a",
        domain="reuters",
        source_type=SourceType.MAINSTREAM_MEDIA,
        created_at="2026-09-26T08:15:02.123456+00:00",
    )

    html = render([article])

    assert 'data-link-id="a1" data-created-at="2026-09-26T08:15:02.123456+00:00"' in html


def test_render_includes_article_template_with_a_cover_and_topic_chip_to_fill() -> None:
    html = render([])

    start = html.index('<template id="article-template">')
    template = html[start : html.index("</template>", start)]
    assert template.count('li class="article"') == 1
    assert 'class="cover-link"' in template
    assert '<a class="topic" href="/t/">' in template
    assert '<a class="entity" href="/e/">' in template
    assert 'id="feed-sentinel"' in html
    assert '<ul class="articles">' in html


def test_render_injects_feed_constants() -> None:
    html = render([])

    assert f"const FEED_PAGE_SIZE = {FEED_PAGE_SIZE};" in html
    assert f"const ARTICLE_TOPIC_CHIPS = {ARTICLE_TOPIC_CHIPS};" in html
    assert f"const ARTICLE_ENTITY_CHIPS = {ARTICLE_ENTITY_CHIPS};" in html
    assert f'const FAVICON_URL_TEMPLATE = "{FAVICON_URL_TEMPLATE}";' in html
    assert "__FEED_PAGE_SIZE__" not in html
    assert "__ARTICLE_TOPIC_CHIPS__" not in html
    assert "__ARTICLE_ENTITY_CHIPS__" not in html
    assert "__FAVICON_URL_TEMPLATE__" not in html


def test_search_queries_the_server_instead_of_filtering_the_page() -> None:
    html = render([])

    assert '.ilike("search_text"' in html
    assert "IntersectionObserver" in html


def _page_script(html: str) -> str:
    return html[html.index('<script type="module">') + len('<script type="module">') : html.index("</script>")]


def test_render_sets_a_csp_that_only_allows_the_page_script_by_hash() -> None:
    html = render([], supabase_url="https://example.supabase.co", supabase_anon_key="k")

    digest = base64.b64encode(hashlib.sha256(_page_script(html).encode()).digest()).decode()
    csp = unescape(re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', html).group(1))
    directives = dict(d.strip().split(" ", 1) for d in csp.split(";"))
    assert directives["script-src"].split() == [f"'sha256-{digest}'", SUPABASE_JS_URL]
    assert directives["connect-src"] == "https://example.supabase.co"
    assert directives["default-src"] == "'none'"


def test_render_uses_no_inline_event_handlers() -> None:
    article = Article(
        id="a1",
        title="Wire story",
        url="https://www.reuters.com/a",
        domain="reuters",
        source_type=SourceType.MAINSTREAM_MEDIA,
    )

    html = render([article])

    assert not re.search(r"\son[a-z]+=", html)


def test_render_escapes_config_so_it_cannot_close_the_script() -> None:
    html = render([], supabase_url="https://x.example/</script><script>alert(1)</script>", supabase_anon_key="k")

    assert html.count("</script>") == 1
    assert "\\u003c/script\\u003e" in _page_script(html)


def test_render_escapes_markup_in_titles_and_topics() -> None:
    article = Article(
        id='a1"><script>alert(1)</script>',
        title="<img src=x onerror=alert(1)>",
        url="https://example.com/a",
        domain="example",
        source_type=SourceType.DIRECT_LINK,
        topics=(Chip("ai", "<b>AI</b>"),),
    )

    html = render([article])

    listed = _article_list(html)
    assert "<script>" not in listed
    assert "<img src=x" not in listed
    assert "<b>AI</b>" not in listed
    assert "&lt;img src=x onerror=alert(1)&gt;" in listed


def test_load_feed_drops_non_http_links_and_covers(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        _row(url="javascript:alert(1)", title="evil"),
        _row(url="https://example.com", title="ok", image_url="javascript:alert(1)"),
    ]

    class _Query:
        def select(self, *_: object) -> "_Query":
            return self

        def order(self, *_: object, **__: object) -> "_Query":
            return self

        def limit(self, *_: object) -> "_Query":
            return self

        def execute(self) -> object:
            return type("R", (), {"data": rows})()

    client = type("C", (), {"table": lambda self, _name: _Query()})()
    monkeypatch.setattr(site, "get_unauthenticated_client", lambda: client)

    articles = build_articles(site.load_feed(), DOMAIN_SOURCE_TYPES)

    assert [article.title for article in articles] == ["ok"]
    assert articles[0].image_url is None


def test_page_script_only_links_http_urls() -> None:
    html = render([])

    script = _page_script(html)
    assert "if (!isHttpUrl(row.url)) return null;" in script
    assert "isHttpUrl(row.image_url)" in script


def test_page_script_ranks_the_default_feed_and_shows_the_formula() -> None:
    html = render([])

    assert 'rpc("ranked_feed"' in html
    assert "your topic scores" in html
    assert "0.5 ^ (age in hours / 24)" in html


def test_my_algorithm_has_sliders_saved_as_overrides_and_a_reset() -> None:
    html = render([])

    assert 'id="taste-reset"' in html
    assert 'from("topic_overrides")' in html
    assert 'slider.setAttribute("role", "slider")' in html
    assert 'id="taste-clear-icon"' in html


def test_domain_line_shows_a_handle_alone_and_follows_with_a_name() -> None:
    from seb_now.site import domain_with_author

    assert domain_with_author("youtube", "@Channel5YouTube") == "@Channel5YouTube"
    assert domain_with_author("youtube", "Some Channel") == "youtube · Some Channel"
    assert domain_with_author("techcrunch", "") == "techcrunch"


def test_render_shows_the_author_on_the_domain_line() -> None:
    articles = build_articles(
        [_row(title="Iran", url="https://www.youtube.com/watch?v=YSLWEsv-8MM", author="@Channel5YouTube")],
        DOMAIN_SOURCE_TYPES,
    )

    html = render(articles)

    assert '<span class="domain">@Channel5YouTube</span>' in _article_list(html)


def test_domain_line_links_to_its_source_and_the_source_is_not_an_entity_chip() -> None:
    from seb_now.site import Chip, _source, _top_entities

    source_id = "11111111-1111-1111-1111-111111111111"
    labels = [
        {"p": 1.0, "found_in": "source", "entities": {"id": source_id, "name": "Channel 5"}},
        {"p": 0.9, "found_in": "title", "entities": {"id": "e1", "name": "Iran"}},
    ]
    assert _top_entities(labels) == (Chip("e1", "Iran"),)
    assert _source(labels) == Chip(source_id, "Channel 5")
    assert _source(labels[1:]) is None

    articles = build_articles(
        [
            _row(
                title="Iran",
                url="https://www.youtube.com/watch?v=YSLWEsv-8MM",
                author="@Channel5YouTube",
                link_entities=labels,
            )
        ],
        DOMAIN_SOURCE_TYPES,
    )
    listing = _article_list(render(articles))
    assert f'<a class="domain" href="/e/{source_id}">@Channel5YouTube</a>' in listing
    assert ">Channel 5<" not in listing


def test_page_script_fills_the_domain_link_and_keeps_sources_off_the_chips() -> None:
    script = render([])[render([]).index('<script type="module">') :]
    assert 'const SOURCE_FOUND_IN = "source";' in script
    assert "le.found_in !== SOURCE_FOUND_IN" in script
    assert "setEntityHref(domain, source.entities.id)" in script


def test_page_labels_entities_from_the_kind_tree_not_the_flat_kind() -> None:
    # A source's flat kind is just "source"; its kind_path says what it is
    # ("youtube channel"), and the kind link already goes there.
    script = render([])[render([]).index('<script type="module">') :]
    assert "function entityKindLabel(entity)" in script
    assert 'kind.replace("_", " ")' not in script


def test_posted_label_shows_month_and_day_adding_the_year_only_for_other_years() -> None:
    from datetime import date

    from seb_now.site import posted_label

    today = date(2026, 9, 30)
    assert posted_label("2026-09-27T16:34:59+00:00", today) == "Sep 27"
    assert posted_label("2025-07-19T11:40:44.123456+00:00", today) == "Jul 19, 2025"
    assert posted_label("2026-09-27T23:30:00-02:00", today) == "Sep 28"
    assert posted_label("", today) == ""
    assert posted_label("not a date", today) == ""


def test_render_puts_the_posted_date_on_the_domain_line() -> None:
    article = Article(
        id="a1",
        title="Issue",
        url="https://thisweekinlebanon.substack.com/p/x",
        domain="substack",
        source_type=SourceType.DIRECT_LINK,
        created_at="2020-09-27T16:34:59+00:00",
    )

    html = render([article])

    assert '<time class="posted" datetime="2020-09-27T16:34:59+00:00">Sep 27, 2020</time>' in html


def test_article_template_carries_an_empty_posted_date_to_fill() -> None:
    html = render([])

    start = html.index('<template id="article-template">')
    template = html[start : html.index("</template>", start)]
    assert '<time class="posted" datetime=""></time>' in template


def test_entity_page_lists_every_link_mentioning_it_and_chips_open_it() -> None:
    html = render([])

    focus = html[
        html.index('<section id="focus" hidden>') : html.index("</section>", html.index('<section id="focus"'))
    ]
    assert '<div id="focus-entity" hidden>' in focus
    assert 'id="focus-entity-name"' in focus and 'id="focus-entity-meta"' in focus
    script = html[html.index('<script type="module">') :]
    assert 'rpc("entity_links"' in script
    assert "`/e/${id}`" in script
    # Chips are links, but a plain click opens the page in place.
    assert (
        "closest(\"a[href^='/e/'], a[href^='/t/'], a[href^='/k/'], a[href^='/i/'], a[href^='/s/'], a[href^='/o/']\")"
        in script
    )
    assert "focusEntity(id, { name: chip.dataset.name ?? chip.textContent })" in script
    assert "else if (entityId) focusEntity(entityId, { push: false });" in script
    # Entity ids become hrefs only when they look like one.
    assert "function setEntityHref(anchor, id)" in script


def test_topic_page_lists_its_links_with_a_find_sources_button_and_chips_open_it() -> None:
    html = render([])

    focus = html[
        html.index('<section id="focus" hidden>') : html.index("</section>", html.index('<section id="focus"'))
    ]
    assert '<div id="focus-topic" hidden>' in focus
    head = focus[focus.index('<div id="focus-head">') :]
    button = head[head.index('<a id="find-sources"') :]
    button = button[: button.index("</a>")]
    assert 'target="_blank" rel="noopener noreferrer"' in button and button.endswith("Find sources")
    script = _page_script(html)
    assert 'rpc("topic_links"' in script and 'rpc("topic_link_count"' in script
    assert "`/t/${id}`" in script
    assert "focusTopic(path, { name: chip.dataset.name ?? chip.textContent })" in script
    assert "link_topics(p, topics(id, name))" in script
    # The prompt and Claude's address come from constants.py, filled per topic.
    assert f'"{FIND_SOURCES_URL_TEMPLATE}"' in script
    assert "encodeURIComponent(prompt)" in script


def test_kind_page_lists_links_its_subkinds_and_top_entities_and_kinds_link_there() -> None:
    html = render([])

    focus = html[
        html.index('<section id="focus" hidden>') : html.index("</section>", html.index('<section id="focus"'))
    ]
    assert '<div id="focus-kind" hidden>' in focus
    assert 'id="focus-kinds-title"' in focus and 'id="focus-kinds"' in focus
    script = _page_script(html)
    assert 'rpc("kind_links"' in script and 'rpc("kind_counts"' in script and 'rpc("kind_entities"' in script
    assert "`/k/${path}`" in script
    assert "focusKind(kindPath, { name: chip.dataset.name ?? chip.textContent })" in script
    assert "else if (kindPathFromPath()) focusKind(kindPathFromPath(), { push: false });" in script
    # An entity's page links its kind, and the search box links a typed kind.
    assert "parentLink(entityKindLabel(entity), setKindHref, entity.kind_path)" in script
    assert "page: markPage(sense.kind.label, setKindHref, sense.kind.path)" in script


def test_entity_page_offers_find_sources_with_its_own_prompt() -> None:
    script = _page_script(render([]))

    assert FIND_ENTITY_SOURCES_PROMPT.split("(")[0] in script
    assert "findSourcesUrl(FIND_ENTITY_SOURCES_PROMPT, {" in script
    assert "findSourcesUrl(FIND_SOURCES_PROMPT, {" in script


VISIT_RETURNS_MIGRATION = Path(__file__).parent.parent / "supabase/migrations/20261014200000_link_visit_returns.sql"


def test_a_clicked_link_records_its_visit_with_keepalive_and_how_the_reader_came_back() -> None:
    script = _page_script(render([]))

    assert 'document.addEventListener("auxclick"' in script
    assert 'startVisit(li.dataset.linkId, newTab || opened.target === "_blank")' in script
    assert "keepalive: true" in script
    assert 'window.addEventListener("pageshow"' in script
    assert 'window.addEventListener("pagehide"' in script
    assert 'performance.getEntriesByType("navigation")' in script
    assert "sessionStorage.setItem(VISIT_STORAGE_KEY" in script
    assert "upsert({" in script and "away_ms: Math.round(awayMs)" in script
    assert "setupVisitReturns();" in script


def test_visit_returns_only_send_values_the_link_visits_checks_allow() -> None:
    script = _page_script(render([]))
    sql = VISIT_RETURNS_MIGRATION.read_text()

    js_cap = re.search(r"const VISIT_AWAY_MAX_MS = ([\d *]+);", script).group(1)
    assert math.prod(int(n) for n in js_cap.split("*")) == int(re.search(r"away_ms between 0 and (\d+)", sql).group(1))
    return_kinds = set(re.findall(r"'(\w+)'", re.search(r"return_kind in \(([^)]*)\)", sql).group(1)))
    next_actions = set(re.findall(r"'(\w+)'", re.search(r"next_action in \(([^)]*)\)", sql).group(1)))
    calls = " ".join(re.findall(r"resolveReturn\(([^;]*)\);", script))
    mapping = re.search(r"const NAVIGATION_RETURN_KINDS = \{([^}]*)\}", script).group(1)
    sent_kinds = set(re.findall(r'"(\w+)"', calls)) | set(re.findall(r': "(\w+)"', mapping))
    assert sent_kinds <= return_kinds, sent_kinds - return_kinds
    sent_actions = set(re.findall(r'noteNextAction\("(\w+)"', script)) | set(
        re.findall(r'value === 1 \? "(\w+)" : "(\w+)"', script)[0]
    )
    assert sent_actions == next_actions, sent_actions ^ next_actions


def test_typed_terms_are_superpositions_of_senses_and_indexicals_have_pages() -> None:
    """A term is one filter over all its senses; indexicals open at /i/<term>."""
    html = render([])
    script = html[html.index('<script type="module">') :]
    # Every sense of the same words is one filter, sent as {"any": [...]}.
    assert "terms: [oneOrAny(senses)]" in script
    assert "return senses.length === 1 && only !== undefined ? only : { any: senses };" in script
    # Indexicals come from the database and are read in a context.
    assert 'client.from("indexicals").select("term, kind_path, context, description")' in script
    assert "return { indexical: indexical.term, at: localNow() };" in script
    assert "return { indexical: indexical.term, focus: queryContext.focus.focus };" in script
    assert "queryContext.focus = currentFocus();" in script
    # Their own pages.
    assert "async function focusIndexical(term" in script
    assert 'client.rpc("indexical_summary", { term, at })' in script
    assert "else if (indexicalFromPath()) focusIndexical(indexicalFromPath(), { push: false });" in script
    # On the page's own index too: a term's senses are a disjunction there.
    assert "const entitySeqs = (term.any ?? [term]).flatMap((sense) => sense.kind" in script


def test_order_pages_open_from_the_search_box() -> None:
    script = _page_script(render([]))
    # A typed sort word ("top") is a tag with a page of its own, routed like a
    # kind's; an indexical ("tonight") opens its /i/ page.
    assert "`/o/${sort}`" in script
    assert "page: markPage(SORT_LABELS[intent.sort], setOrderHref, intent.sort)" in script
    assert "page: markPage(indexical.term, setIndexicalHref, indexical.term)" in script
    assert "else if (orderFromPath()) focusOrder(orderFromPath(), { push: false });" in script
    # An order's page is feed_query with just that sort.
    assert 'resetFeed("", SORT_LABELS[sort] ? { sort } : null);' in script


def test_search_tags_never_choose_a_sense_and_a_term_page_lists_them() -> None:
    """A name with several senses is one tag opening /s/<words>; a prefix only completes one name."""
    script = _page_script(render([]))
    # Typed names come from one lexicon of every sense, claimed by senses.ts.
    assert "claimNames(tokens, entries, wordMatches, complete)" in script
    assert "lexicon(namedSenses(entities, topics), queryWords, (sense) => sense.id)" in script
    # Several senses: one tag, labelled with what they share, opening their term's page.
    assert "kind: senseLabel(entry.senses, kindName)," in script
    assert "page: markPage(term, setTermHref, term)," in script
    assert "const TERM_PATH_PATTERN = new RegExp(`^/s/(${TERM_ID_PATTERN})/?$`);" in script
    assert "else if (termFromPath()) focusTerm(termFromPath(), { push: false });" in script
    # The term page lists the posts about any sense, as one filter_links term.
    assert "feed.filter = Filter.term(filterSenses, term, senses.map((sense) => sense.label), local);" in script
    # Required entities are read from whole words only.
    assert "tagTokens(text, intent, matchTopics(text), entities, false)" in script


def test_render_inlines_the_compiled_filter_script_into_the_page_script() -> None:
    html = render([])
    script = html[html.index('<script type="module">') : html.index("</script>")]

    assert "__PRELUDE_JS__" not in html
    assert "__FILTER_JS__" not in html
    assert "__SENSES_JS__" not in html
    assert "const Result = {" in script and "function match(" in script
    assert "function filterKey(" in script and "const Filter = {" in script
    assert "function claimNames(" in script and "function senseLabel(" in script
    assert "const fetchServerFiltered = memoize(filterPageKey" in script
    # The local index keeps its own offset-based path; filter_links pages by keyset.
    assert "if (entityIndex.ready && filter.local) return fetchLocalFiltered(client, filter.local, offset);" in script
    assert "before_created_at: cursor?.createdAt ?? null" in script


def test_compiled_scripts_that_could_close_the_page_script_are_refused(tmp_path: Path) -> None:
    path = tmp_path / "evil.js"
    path.write_text('const s = "</SCRIPT><script>alert(1)";')

    with pytest.raises(ValueError):
        site.compiled_script(path)
