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
