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


def test_render_groups_by_source_type_in_label_order() -> None:
    articles = [
        Article(
            id="a1", title="Blog post", url="https://blog.example.com/a", source_type=SourceType.DIRECT_LINK, cluster_id=0
        ),
        Article(
            id="a2",
            title="Long-form video",
            url="https://youtu.be/x",
            source_type=SourceType.YOUTUBE_LONGFORM,
            cluster_id=0,
        ),
        Article(
            id="a3",
            title="Wire story",
            url="https://www.reuters.com/a",
            source_type=SourceType.MAINSTREAM_MEDIA,
            cluster_id=0,
        ),
    ]

    html = render(articles)

    mainstream_index = html.index("Mainstream Media")
    youtube_index = html.index("YouTube Long-form")
    direct_index = html.index("Direct Link")
    assert mainstream_index < youtube_index < direct_index
    assert html.index("Wire story") < youtube_index
    assert html.index("Long-form video") < direct_index
    assert "Blog post" in html


def test_render_omits_empty_groups() -> None:
    articles = [
        Article(
            id="a1",
            title="Wire story",
            url="https://www.reuters.com/a",
            source_type=SourceType.MAINSTREAM_MEDIA,
            cluster_id=0,
        )
    ]

    html = render(articles)

    assert "Mainstream Media" in html
    assert "YouTube Long-form" not in html
    assert "Direct Link" not in html


def test_render_includes_swipeable_article_with_link_id() -> None:
    articles = [
        Article(
            id="a1",
            title="Wire story",
            url="https://www.reuters.com/a",
            source_type=SourceType.MAINSTREAM_MEDIA,
            cluster_id=0,
        )
    ]

    html = render(articles)

    assert 'li class="article" data-link-id="a1"' in html
    assert 'class="swipe-bg"' in html
    assert 'class="swipe-content"' in html


def test_render_includes_settings_icon() -> None:
    html = render([])

    assert 'id="settings-btn"' in html
    assert 'id="settings-panel"' in html


def test_render_injects_supabase_config() -> None:
    html = render([], supabase_url="https://example.supabase.co", supabase_anon_key="test-anon-key")

    assert "https://example.supabase.co" in html
    assert "test-anon-key" in html
    assert "__SUPABASE_URL__" not in html
    assert "__SUPABASE_ANON_KEY__" not in html
