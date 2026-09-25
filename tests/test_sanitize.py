import pytest

from seb_now.sanitize import render_markdown, safe_http_url


@pytest.mark.parametrize("url", ["https://example.com/a", "http://example.com", "HTTPS://EXAMPLE.COM"])
def test_safe_http_url_keeps_http_urls(url: str) -> None:
    assert safe_http_url(url) == url


@pytest.mark.parametrize(
    "url",
    [None, "", "javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x"],
)
def test_safe_http_url_rejects_other_schemes(url: str | None) -> None:
    assert safe_http_url(url) is None


@pytest.mark.parametrize(
    "body",
    [
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(1)">',
        "[click](javascript:alert(1))",
        '<a href="javascript:alert(1)">x</a>',
        '<iframe src="https://evil.example"></iframe>',
    ],
)
def test_render_markdown_strips_executable_html(body: str) -> None:
    html = render_markdown(body, ["extra"])
    for needle in ("<script", "onerror", "javascript:", "<iframe"):
        assert needle not in html.lower()


def test_render_markdown_keeps_ordinary_formatting() -> None:
    html = render_markdown("# Title\n\n```\ncode\n```\n\n| a |\n|---|\n| b |", ["extra"])
    assert "<h1>Title</h1>" in html
    assert "<code>" in html
    assert "<table>" in html
