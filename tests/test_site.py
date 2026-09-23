from seb_now.constants import SourceType
from seb_now.site import Article, build_articles, render

FEED_FIXTURE = [
    {"id": "11111111-1111-1111-1111-111111111111", "title": "Fed signals rate cut as inflation cools", "url": "https://www.nytimes.com/a"},
    {"id": "22222222-2222-2222-2222-222222222222", "title": "Fed chair explains the rate decision in full", "url": "https://www.youtube.com/watch?v=a"},
    {"id": "33333333-3333-3333-3333-333333333333", "title": "My take on the Fed's rate cut", "url": "https://sebswrites.example.com/posts/a"},
]


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
            cluster_id=0,
        ),
        Article(
            id="a2",
            title="Wire story",
            url="https://www.reuters.com/a",
            domain="reuters",
            source_type=SourceType.MAINSTREAM_MEDIA,
            cluster_id=0,
        ),
    ]

    html = render(articles)

    assert "Blog post" in html
    assert "Wire story" in html
    assert "Mainstream Media" not in html
    assert "Direct Link" not in html
    assert "<h2>" not in html
    assert html.count('li class="article"') == 2


def test_render_includes_swipeable_article_with_link_id_and_domain() -> None:
    articles = [
        Article(
            id="a1",
            title="Wire story",
            url="https://www.reuters.com/a",
            domain="reuters",
            source_type=SourceType.MAINSTREAM_MEDIA,
            cluster_id=0,
        )
    ]

    html = render(articles)

    assert 'li class="article" data-link-id="a1"' in html
    assert 'class="swipe-bg"' in html
    assert 'class="swipe-content"' in html
    assert 'class="score"' in html
    assert '<span class="domain">reuters</span>' in html


def test_render_includes_settings_icon() -> None:
    html = render([])

    assert 'id="settings-btn"' in html
    assert 'id="settings-panel"' in html


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
