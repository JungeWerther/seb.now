import base64
import hashlib
import re
from html import unescape
from uuid import uuid4

import pytest

from seb_now import site
from seb_now.constants import ARTICLE_TOPIC_CHIPS, FAVICON_URL_TEMPLATE, FEED_PAGE_SIZE, SourceType
from seb_now.site import Article, _top_topic_names, build_articles, render

FEED_FIXTURE = [
    {"id": "11111111-1111-1111-1111-111111111111", "title": "Fed signals rate cut as inflation cools", "url": "https://www.nytimes.com/a"},
    {"id": "22222222-2222-2222-2222-222222222222", "title": "Fed chair explains the rate decision in full", "url": "https://www.youtube.com/watch?v=a"},
    {"id": "33333333-3333-3333-3333-333333333333", "title": "My take on the Fed's rate cut", "url": "https://sebswrites.example.com/posts/a"},
]


def _article_list(html: str) -> str:
    """The pre-rendered <ul class="articles">, without the #article-template copy."""
    start = html.index('<ul class="articles">')
    return html[start : html.index("</ul>", start)]


def test_build_articles_classifies_source_type() -> None:
    articles = build_articles(FEED_FIXTURE)

    source_types = {article.source_type for article in articles}
    assert source_types == {SourceType.MAINSTREAM_MEDIA, SourceType.YOUTUBE_LONGFORM, SourceType.DIRECT_LINK}


def test_build_articles_computes_display_domain() -> None:
    articles = build_articles(FEED_FIXTURE)

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
    assert f'<span class="favicon" data-letter="R" aria-hidden="true"><img src="{favicon_url}" alt="" loading="lazy"></span>' in html
    assert html.index('class="favicon"') < html.index('class="card-body"')

def test_build_articles_keeps_feed_topics() -> None:
    feed = [{**FEED_FIXTURE[0], "topics": ["AI models", "Open source"]}, FEED_FIXTURE[1]]

    articles = build_articles(feed)

    assert articles[0].topics == ("AI models", "Open source")
    assert articles[1].topics == ()


def test_top_topic_names_orders_by_p_and_caps_at_chip_count() -> None:
    link_topics = [
        {"p": 0.5, "topics": {"name": "Big tech"}},
        {"p": 0.9, "topics": {"name": "AI models"}},
        {"p": 0.7, "topics": {"name": "Open source"}},
    ]

    assert _top_topic_names(link_topics) == ["AI models", "Open source"][:ARTICLE_TOPIC_CHIPS]


def test_render_shows_topic_chips_and_omits_them_when_untagged() -> None:
    tagged = Article(
        id="a1",
        title="Tagged",
        url="https://example.com/a",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
        topics=("AI models", "Open source"),
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
        '<span class="topics"><span class="topic">AI models</span>'
        '<span class="topic">Open source</span></span>'
    ) in html
    assert _article_list(html).count('<span class="topics">') == 1
    assert "cluster" not in html


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
        assert match.group(2) in "'\"", f"non-literal {match.group(1)} assignment: {script[match.start():match.start() + 80]}"
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
    for overlay, label in (("taste-overlay", "My Algorithm"), ("profile-overlay", "My Profile")):
        assert f'data-overlay="{overlay}"' in menu
        assert label in menu
        assert f'<dialog id="{overlay}" class="overlay"' in html


def test_render_includes_svg_wordmark() -> None:
    html = render([])

    assert '<h1 class="brand">' in html
    assert '<svg class="wordmark"' in html
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

    template = html[html.index('<template id="article-template">') : html.index("</template>")]
    assert template.count('li class="article"') == 1
    assert 'class="cover-link"' in template
    assert '<span class="topic">' in template
    assert 'id="feed-sentinel"' in html
    assert '<ul class="articles">' in html


def test_render_injects_feed_constants() -> None:
    html = render([])

    assert f"const FEED_PAGE_SIZE = {FEED_PAGE_SIZE};" in html
    assert f"const ARTICLE_TOPIC_CHIPS = {ARTICLE_TOPIC_CHIPS};" in html
    assert f'const FAVICON_URL_TEMPLATE = "{FAVICON_URL_TEMPLATE}";' in html
    assert "__FEED_PAGE_SIZE__" not in html
    assert "__ARTICLE_TOPIC_CHIPS__" not in html
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
    assert directives["script-src"].split() == [f"'sha256-{digest}'", "https://esm.sh"]
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
        topics=("<b>AI</b>",),
    )

    html = render([article])

    listed = _article_list(html)
    assert "<script>" not in listed
    assert "<img src=x" not in listed
    assert "<b>AI</b>" not in listed
    assert "&lt;img src=x onerror=alert(1)&gt;" in listed


def test_load_feed_drops_non_http_links_and_covers(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        {"id": str(uuid4()), "url": "javascript:alert(1)", "title": "evil", "image_url": None,
         "created_at": "2026-01-01T00:00:00+00:00", "link_topics": []},
        {"id": str(uuid4()), "url": "https://example.com", "title": "ok", "image_url": "javascript:alert(1)",
         "created_at": "2026-01-01T00:00:00+00:00", "link_topics": []},
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

    feed = site.load_feed()

    assert [item["title"] for item in feed] == ["ok"]
    assert feed[0]["image_url"] == ""


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
