from seb_now.constants import SourceType
from seb_now.site import build_articles, group_by_source_type


FEED_ITEMS = [
    ("Fed signals rate cut as inflation cools", "https://www.nytimes.com/fed-rate-cut"),
    ("Fed chair explains the rate decision in full", "https://www.youtube.com/watch?v=fed001"),
    ("My take on the Fed's rate cut", "https://sebswrites.example.com/fed-take"),
    ("Stocks rally after inflation data beats forecasts", "https://www.reuters.com/stocks-rally"),
]


def test_build_articles_classifies_source_type() -> None:
    articles = build_articles(FEED_ITEMS)

    source_types = {article.source_type for article in articles}
    assert source_types == {SourceType.MAINSTREAM_MEDIA, SourceType.YOUTUBE_LONGFORM, SourceType.DIRECT_LINK}


def test_build_articles_preserves_title_and_url() -> None:
    articles = build_articles(FEED_ITEMS)

    assert [(a.title, a.url) for a in articles] == FEED_ITEMS


def test_build_articles_tags_same_topic_with_same_cluster_id() -> None:
    articles = build_articles(FEED_ITEMS)
    by_title = {a.title: a.cluster_id for a in articles}

    assert by_title[FEED_ITEMS[0][0]] == by_title[FEED_ITEMS[1][0]] == by_title[FEED_ITEMS[2][0]]
    assert by_title[FEED_ITEMS[3][0]] != by_title[FEED_ITEMS[0][0]]


def test_group_by_source_type_buckets_and_omits_nothing_present() -> None:
    articles = build_articles(FEED_ITEMS)

    groups = group_by_source_type(articles)

    assert [a.title for a in groups[SourceType.MAINSTREAM_MEDIA]] == [
        FEED_ITEMS[0][0],
        FEED_ITEMS[3][0],
    ]
    assert [a.title for a in groups[SourceType.YOUTUBE_LONGFORM]] == [FEED_ITEMS[1][0]]
    assert [a.title for a in groups[SourceType.DIRECT_LINK]] == [FEED_ITEMS[2][0]]
