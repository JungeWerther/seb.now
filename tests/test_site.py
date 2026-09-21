from seb_now.constants import SourceType
from seb_now.site import Article, build_articles, load_feed, render


def test_load_feed_reads_bundled_articles() -> None:
    feed = load_feed()

    assert len(feed) > 0
    assert all({"title", "url"} <= item.keys() for item in feed)


def test_build_articles_classifies_source_type() -> None:
    articles = build_articles(load_feed())

    source_types = {article.source_type for article in articles}
    assert source_types == {SourceType.MAINSTREAM_MEDIA, SourceType.YOUTUBE_LONGFORM, SourceType.DIRECT_LINK}


def test_render_groups_by_source_type_in_label_order() -> None:
    articles = [
        Article(title="Blog post", url="https://blog.example.com/a", source_type=SourceType.DIRECT_LINK, cluster_id=0),
        Article(
            title="Long-form video",
            url="https://youtu.be/x",
            source_type=SourceType.YOUTUBE_LONGFORM,
            cluster_id=0,
        ),
        Article(
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
