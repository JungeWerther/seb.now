import re
from html import unescape
from urllib.parse import urlsplit

import pytest

from seb_now.consent import render_consent
from seb_now.constants import SUPABASE_JS_INTEGRITY, SUPABASE_JS_URL
from seb_now.sanitize import PAGE_SCRIPT_PATTERN, is_safe_slug, render_markdown, safe_http_url, script_json
from seb_now.site import render


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


@pytest.mark.parametrize("slug", ["hello", "hello-world", "post-2026"])
def test_is_safe_slug_accepts_plain_slugs(slug: str) -> None:
    assert is_safe_slug(slug)


@pytest.mark.parametrize("slug", ["", "../etc", "a/b", "Hello", "-x", "x-", "a b", "a\"b", "a%2fb"])
def test_is_safe_slug_rejects_paths_and_markup(slug: str) -> None:
    assert not is_safe_slug(slug)


def test_script_json_cannot_close_a_script_tag() -> None:
    encoded = script_json("</script><!-- \u2028")
    assert "<" not in encoded and ">" not in encoded and "\u2028" not in encoded
    assert encoded == '"\\u003c/script\\u003e\\u003c!-- \\u2028"'


def _rendered_pages() -> list[str]:
    url = "https://example.supabase.co"
    return [render([], supabase_url=url, supabase_anon_key="k"), render_consent(supabase_url=url, supabase_anon_key="k")]


@pytest.mark.parametrize("html", _rendered_pages(), ids=["index", "consent"])
def test_csp_script_src_names_exact_files_not_whole_origins(html: str) -> None:
    csp = unescape(re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', html).group(1))
    directives = dict(d.strip().split(" ", 1) for d in csp.split(";"))
    hosts = [source for source in directives["script-src"].split() if not source.startswith("'")]
    assert hosts, "expected supabase-js's URL in script-src"
    for source in hosts:
        path = urlsplit(source).path
        assert path not in ("", "/") and not path.endswith("/"), f"{source} allows more than one file"


@pytest.mark.parametrize("html", _rendered_pages(), ids=["index", "consent"])
def test_page_stays_hidden_unless_its_script_finds_it_unframed(html: str) -> None:
    assert "html:not(.unframed) body { display: none !important; }" in html
    script = PAGE_SCRIPT_PATTERN.search(html).group(1).lstrip()
    assert script.startswith('if (window.top !== window.self) throw new Error(')
    assert 'document.documentElement.classList.add("unframed");' in script


@pytest.mark.parametrize("html", _rendered_pages(), ids=["index", "consent"])
def test_supabase_js_loads_with_subresource_integrity(html: str) -> None:
    script = PAGE_SCRIPT_PATTERN.search(html).group(1)
    assert f"script.src = {script_json(SUPABASE_JS_URL)};" in script
    assert f"script.integrity = {script_json(SUPABASE_JS_INTEGRITY)};" in script
    assert re.fullmatch(r"sha384-[A-Za-z0-9+/]{64}", SUPABASE_JS_INTEGRITY)
