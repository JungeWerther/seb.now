from seb_now.constants import SourceType
from seb_now.source_type import classify_source, group_by_source_type

DOMAIN_SOURCE_TYPES = {
    "nytimes.com": SourceType.MAINSTREAM_MEDIA,
    "bbc.co.uk": SourceType.MAINSTREAM_MEDIA,
    "reuters.com": SourceType.MAINSTREAM_MEDIA,
    "youtube.com": SourceType.YOUTUBE_LONGFORM,
    "youtu.be": SourceType.YOUTUBE_LONGFORM,
}


def test_classifies_mainstream_media_domain() -> None:
    assert classify_source("https://www.nytimes.com/2026/09/21/us/politics.html", DOMAIN_SOURCE_TYPES) == (
        SourceType.MAINSTREAM_MEDIA
    )


def test_classifies_mainstream_media_domain_without_www() -> None:
    assert classify_source("https://bbc.co.uk/news/world", DOMAIN_SOURCE_TYPES) == SourceType.MAINSTREAM_MEDIA


def test_classifies_youtube_watch_link() -> None:
    assert classify_source("https://www.youtube.com/watch?v=abc123", DOMAIN_SOURCE_TYPES) == (
        SourceType.YOUTUBE_LONGFORM
    )


def test_classifies_youtu_be_short_link() -> None:
    assert classify_source("https://youtu.be/abc123", DOMAIN_SOURCE_TYPES) == SourceType.YOUTUBE_LONGFORM


def test_classifies_unrecognized_domain_as_direct_link() -> None:
    assert classify_source("https://some-blogger.example.com/post/1", DOMAIN_SOURCE_TYPES) == SourceType.DIRECT_LINK


def test_group_by_source_type_buckets_and_preserves_order() -> None:
    urls = [
        "https://www.nytimes.com/a",
        "https://youtu.be/xyz",
        "https://blog.example.com/post",
        "https://www.reuters.com/b",
    ]

    groups = group_by_source_type(urls, DOMAIN_SOURCE_TYPES)

    assert groups == {
        SourceType.MAINSTREAM_MEDIA: ["https://www.nytimes.com/a", "https://www.reuters.com/b"],
        SourceType.YOUTUBE_LONGFORM: ["https://youtu.be/xyz"],
        SourceType.DIRECT_LINK: ["https://blog.example.com/post"],
    }


def test_group_by_source_type_omits_empty_buckets() -> None:
    groups = group_by_source_type(["https://www.nytimes.com/a"], DOMAIN_SOURCE_TYPES)

    assert groups == {SourceType.MAINSTREAM_MEDIA: ["https://www.nytimes.com/a"]}
