from datetime import datetime, timezone
from uuid import uuid4

from seb_now.domain.models import Link
from seb_now.posts import post_from_link, render_post


def _link(**overrides: object) -> Link:
    fields = {
        "id": uuid4(),
        "url": "https://seb.now/posts/a-test-post/",
        "title": "A Test Post",
        "description": "A short description.",
        "origin": "local",
        "slug": "a-test-post",
        "image_url": "https://example.com/cover.jpg",
        "body_markdown": "# Heading\n\nSome *body* text with a [link](https://example.com).",
        "created_at": datetime(2026, 1, 5, tzinfo=timezone.utc),
    }
    fields.update(overrides)
    return Link.model_validate(fields)


def test_post_from_link_renders_markdown_body() -> None:
    post = post_from_link(_link())

    assert post.slug == "a-test-post"
    assert post.title == "A Test Post"
    assert post.date == "2026-01-05"
    assert post.description == "A short description."
    assert post.image == "https://example.com/cover.jpg"
    assert "<h1>Heading</h1>" in post.body_html
    assert "<em>body</em>" in post.body_html
    assert '<a href="https://example.com" rel="noopener noreferrer">link</a>' in post.body_html


def test_post_from_link_defaults_description_to_empty_and_image_to_none() -> None:
    post = post_from_link(_link(description=None, image_url=None))

    assert post.description == ""
    assert post.image is None


def test_post_url_is_under_posts_path() -> None:
    post = post_from_link(_link())

    assert post.url == "https://seb.now/posts/a-test-post/"


def test_render_post_includes_title_og_tags_and_body() -> None:
    post = post_from_link(_link())

    html = render_post(post)

    assert "<title>A Test Post — seb.now</title>" in html
    assert 'property="og:title" content="A Test Post"' in html
    assert 'property="og:image" content="https://example.com/cover.jpg"' in html
    assert "<h1>Heading</h1>" in html
    assert 'href="https://seb.now/"' in html


def test_render_post_shows_cover_image_above_title_when_present() -> None:
    post = post_from_link(_link())

    html = render_post(post)

    assert '<img class="cover" src="https://example.com/cover.jpg" alt="" loading="lazy">' in html
    cover_index = html.index('<img class="cover"')
    title_index = html.index("<h1>A Test Post</h1>")
    assert cover_index < title_index


def test_render_post_omits_cover_and_og_image_when_no_image() -> None:
    post = post_from_link(_link(image_url=None))

    html = render_post(post)

    assert "og:image" not in html
    assert 'class="cover"' not in html
