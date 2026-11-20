"""The build's design tokens: the built-in styles' values, in the page's <style>."""

import re

from seb_now.site import StyleRow, render, style_tokens_css

LENGTH = {"type": "string", "pattern": "^(0|[0-9]{1,4}(\\.[0-9]{1,3})?(px|rem|em|vw|vh|%))$"}
LAYOUT = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"column_width": {"$ref": "#/$defs/length"}, "dock_width": {"$ref": "#/$defs/length"}},
    "required": ["column_width", "dock_width"],
    "$defs": {"length": LENGTH},
}


def _style(name: str, style: dict[str, object], path: str = "entity.style.layout") -> StyleRow:
    return {"name": name, "kind_path": path, "style": style, "kinds": {"path": path, "schema": LAYOUT}}


def test_the_first_built_in_style_of_a_type_sets_its_tokens() -> None:
    css = style_tokens_css(
        [
            _style("a layout", {"column_width": "640px", "dock_width": "30rem"}),
            _style("b layout", {"column_width": "1px", "dock_width": "1px"}),
        ]
    )
    assert css == ":root { --column-width: 640px; --dock-width: 30rem; }"


def test_a_style_its_type_refuses_sets_nothing() -> None:
    assert style_tokens_css([_style("bad", {"column_width": "1px;}body{display:none", "dock_width": "1px"})]) == ""
    assert style_tokens_css([_style("short", {"column_width": "640px"})]) == ""
    assert style_tokens_css([{"name": "untyped", "kind_path": None, "style": None, "kinds": None}]) == ""


def test_the_tokens_override_the_templates_defaults() -> None:
    css = style_tokens_css([_style("layout", {"column_width": "640px", "dock_width": "30rem"})])
    html = render([], style_css=css)
    style = html[html.index("<style>") : html.index("</style>")]
    defaults = style.index("--column-width: 720px;")
    assert defaults < style.index(css)
    assert "/*__STYLE_TOKENS__*/" not in html


def test_every_width_reads_a_token() -> None:
    style = render([])[: render([]).index("</style>")]
    assert re.findall(r"\b(720|480)px", style) == ["720", "480"]


BLOCK = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "block_depth": {"$ref": "#/$defs/length"},
        "block_line": {"$ref": "#/$defs/length"},
        "block_radius": {"$ref": "#/$defs/length"},
        "block_ink": {"$ref": "#/$defs/color"},
        "block_ink_dark": {"$ref": "#/$defs/color"},
    },
    "required": ["block_depth", "block_line", "block_radius", "block_ink", "block_ink_dark"],
    "$defs": {"length": LENGTH, "color": {"type": "string", "pattern": "^#[0-9a-f]{6}([0-9a-f]{2})?$"}},
}
BUILT_IN_BLOCK = {
    "block_depth": "5px",
    "block_line": "2px",
    "block_radius": "0",
    "block_ink": "#111111",
    "block_ink_dark": "#e8e8e8",
}


def _pages() -> dict[str, str]:
    from seb_now.connect import render_connect
    from seb_now.consent import render_consent
    from seb_now.posts import Post, render_post

    post = Post(slug="p", title="t", date="d", description="", image="https://example.com/i.png", body_html="<p>b</p>")
    return {
        "index": render([]),
        "consent": render_consent(),
        "connect": render_connect(),
        "post": render_post(post),
    }


def _styles(html: str) -> str:
    return "".join(re.findall(r"<style>(.*?)</style>", html, flags=re.S))


def test_the_built_in_block_style_sets_the_block_tokens() -> None:
    css = style_tokens_css(
        [
            {
                "name": "seb.now block",
                "kind_path": "entity.style.block",
                "style": BUILT_IN_BLOCK,
                "kinds": {"path": "entity.style.block", "schema": BLOCK},
            }
        ]
    )
    assert css == (
        ":root { --block-depth: 5px; --block-ink: #111111; --block-ink-dark: #e8e8e8; "
        "--block-line: 2px; --block-radius: 0; }"
    )
    html = render([], style_css=css)
    assert html.index("--block-depth: 5px;\n") < html.index(css)


def test_every_page_carries_the_block_look() -> None:
    for name, html in _pages().items():
        style = _styles(html)
        assert "/*__BLOCK_CSS__*/" not in html, name
        assert "--extrusion:" in style and "var(--block-edge)" in style, name


def test_every_corner_reads_the_radius_token() -> None:
    for name, html in _pages().items():
        radii = re.findall(r"border-radius:\s*([^;]+);", _styles(html))
        assert radii, name
        assert {radius for radius in radii} <= {"var(--block-radius)", "inherit"}, name


def test_no_soft_shadows() -> None:
    """A shadow is the extrusion or a hard ring, never a blurred one."""
    for name, html in _pages().items():
        for shadow in re.findall(r"box-shadow:\s*([^;]+);", _styles(html)):
            for layer in re.split(r",(?![^(]*\))", shadow):
                lengths = re.findall(r"(?<![\w.(])(-?[\d.]+(?:px|em|rem)?|0)(?=\s)", layer + " ")
                assert len(lengths) < 3 or float(re.sub(r"[a-z]+", "", lengths[2])) == 0, (name, layer)
