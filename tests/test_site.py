from seb_now.constants import ARTICLE_TOPIC_CHIPS, SourceType
from seb_now.site import Article, _top_topic_names, build_articles, render

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
    assert html.count('li class="article"') == 2


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


def test_render_shows_cover_image_above_domain_and_title_when_present() -> None:
    with_cover = Article(
        id="a1",
        title="Has cover",
        url="https://example.com/a",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
        image_url="https://example.com/cover.jpg",
    )
    without_cover = Article(
        id="a2",
        title="No cover",
        url="https://example.com/b",
        domain="example.com",
        source_type=SourceType.DIRECT_LINK,
    )

    html = render([with_cover, without_cover])

    assert '<img class="cover" src="https://example.com/cover.jpg" alt="" loading="lazy">' in html
    assert html.count('class="cover"') == 1
    # the cover image comes before the domain/title in the same article
    cover_index = html.index('<img class="cover"')
    domain_index = html.index('<span class="domain">example.com</span>', cover_index)
    assert cover_index < domain_index


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
    assert html.count('<span class="topics">') == 1
    assert "cluster" not in html


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
