from pathlib import Path

from seb_now.posts import load_post, load_posts, render_post

POST_FIXTURE = """---
title: A Test Post
date: 2026-01-05
description: A short description.
image: https://example.com/cover.jpg
---
# Heading

Some *body* text with a [link](https://example.com).
"""


def _write(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name
    path.write_text(content)
    return path


def test_load_post_parses_frontmatter_and_renders_markdown(tmp_path: Path) -> None:
    path = _write(tmp_path, "a-test-post.md", POST_FIXTURE)

    post = load_post(path)

    assert post.slug == "a-test-post"
    assert post.title == "A Test Post"
    assert post.date == "2026-01-05"
    assert post.description == "A short description."
    assert post.image == "https://example.com/cover.jpg"
    assert "<h1>Heading</h1>" in post.body_html
    assert "<em>body</em>" in post.body_html
    assert '<a href="https://example.com">link</a>' in post.body_html


def test_load_post_defaults_slug_to_filename_and_title_to_slug(tmp_path: Path) -> None:
    path = _write(tmp_path, "untitled.md", "---\ndate: 2026-01-01\n---\nHi.")

    post = load_post(path)

    assert post.slug == "untitled"
    assert post.title == "untitled"


def test_post_url_is_under_posts_path(tmp_path: Path) -> None:
    path = _write(tmp_path, "a-test-post.md", POST_FIXTURE)

    post = load_post(path)

    assert post.url == "https://seb.now/posts/a-test-post/"


def test_load_posts_sorts_newest_first(tmp_path: Path) -> None:
    _write(tmp_path, "older.md", "---\ntitle: Older\ndate: 2026-01-01\n---\nBody.")
    _write(tmp_path, "newer.md", "---\ntitle: Newer\ndate: 2026-02-01\n---\nBody.")

    posts = load_posts(tmp_path)

    assert [post.slug for post in posts] == ["newer", "older"]


def test_load_posts_on_missing_directory_returns_empty(tmp_path: Path) -> None:
    assert load_posts(tmp_path / "does-not-exist") == []


def test_render_post_includes_title_og_tags_and_body(tmp_path: Path) -> None:
    path = _write(tmp_path, "a-test-post.md", POST_FIXTURE)
    post = load_post(path)

    html = render_post(post)

    assert "<title>A Test Post — seb.now</title>" in html
    assert 'property="og:title" content="A Test Post"' in html
    assert 'property="og:image" content="https://example.com/cover.jpg"' in html
    assert "<h1>Heading</h1>" in html
    assert 'href="https://seb.now/"' in html
