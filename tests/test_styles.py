from enum import StrEnum

import pytest
from pydantic import ValidationError

from seb_now.styles import UnsupportedSchema, style_model

DEFS = {
    "color": {"type": "string", "pattern": "^#[0-9a-f]{6}([0-9a-f]{2})?$"},
    "length": {"type": "string", "pattern": "^(0|[0-9]{1,4}(\\.[0-9]{1,3})?(px|rem|em|vw|vh|%))$"},
    "number": {"type": "number", "minimum": -10000, "maximum": 10000},
}


def compiled(properties: dict[str, object], defs: dict[str, object] = DEFS) -> dict[str, object]:
    """A schema in the shape style_type_schema() stores."""
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": sorted(properties),
        "$defs": defs,
    }


THEME = compiled(
    {
        "bg": {"$ref": "#/$defs/color", "description": "Page background"},
        "column_width": {"$ref": "#/$defs/length"},
        "weight": {"$ref": "#/$defs/number"},
        "density": {"enum": ["compact", "roomy"]},
    }
)
DARK = {"bg": "#101010", "column_width": "720px", "weight": 1.5, "density": "compact"}


def test_a_style_of_the_type_validates() -> None:
    assert style_model("theme", THEME).model_validate(DARK).model_dump() == DARK


@pytest.mark.parametrize(
    "style",
    [
        pytest.param({**DARK, "bg": "url(https://x/?leak)"}, id="url-value"),
        pytest.param({**DARK, "column_width": "720px;}body{"}, id="breakout"),
        pytest.param({**DARK, "weight": 10001}, id="out-of-bounds"),
        pytest.param({**DARK, "weight": "1.5"}, id="number-as-string"),
        pytest.param({**DARK, "weight": True}, id="boolean-as-number"),
        pytest.param({**DARK, "bg": 101010}, id="number-as-colour"),
        pytest.param({**DARK, "density": "tight"}, id="not-in-enum"),
        pytest.param({key: value for key, value in DARK.items() if key != "bg"}, id="missing-token"),
        pytest.param({**DARK, "extra": "1"}, id="extra-token"),
    ],
)
def test_a_style_outside_the_type_is_refused(style: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        style_model("theme", THEME).model_validate(style)


@pytest.mark.parametrize(
    "schema",
    [
        pytest.param(compiled({"x": {"type": "string", "pattern": "(a+)+$"}}), id="token-with-own-pattern"),
        pytest.param(compiled({"x": {"$ref": "https://evil.example/s.json"}}), id="remote-ref"),
        pytest.param(compiled({"x": {"$ref": "#/$defs/nope"}}), id="unknown-primitive"),
        pytest.param(compiled({"x": {"$ref": "#/$defs/color", "pattern": ".*"}}), id="ref-with-pattern"),
        pytest.param(compiled({"x": {"enum": [1, 2]}}), id="enum-of-numbers"),
        pytest.param(compiled({"x": {"enum": []}}), id="empty-enum"),
        pytest.param(
            compiled({"x": {"$ref": "#/$defs/odd"}}, {"odd": {"type": "string", "format": "uri"}}),
            id="primitive-keyword",
        ),
        pytest.param(compiled({"x": {"$ref": "#/$defs/odd"}}, {"odd": {"type": "boolean"}}), id="primitive-type"),
        pytest.param({**THEME, "additionalProperties": True}, id="open-object"),
        pytest.param({**THEME, "required": ["bg"]}, id="optional-token"),
        pytest.param({**THEME, "if": {}}, id="extra-keyword"),
    ],
)
def test_a_schema_outside_the_vocabulary_is_refused(schema: dict[str, object]) -> None:
    with pytest.raises(UnsupportedSchema):
        style_model("odd", schema)


def test_an_enum_token_reads_as_a_str_enum() -> None:
    style = style_model("theme", THEME).model_validate(DARK)
    density = style.model_dump()["density"]
    assert isinstance(density, StrEnum) and density == "compact"
    assert [member.value for member in type(density)] == ["compact", "roomy"]


def test_keywords_named_like_enum_attributes() -> None:
    model = style_model("odd", compiled({"x": {"enum": ["name", "value", "mro"]}}))
    assert model.model_validate({"x": "value"}).model_dump() == {"x": "value"}


def test_an_integer_is_a_number() -> None:
    assert style_model("theme", THEME).model_validate({**DARK, "weight": 2}).model_dump()["weight"] == 2


@pytest.mark.parametrize("name", ["model_config", "model_dump", "schema", "json", "copy", "dict", "fields"])
def test_a_token_may_be_named_like_a_model_attribute(name: str) -> None:
    model = style_model(name, compiled({name: {"enum": ["a", "b"]}, "bg": {"$ref": "#/$defs/color"}}))
    style = {name: "a", "bg": "#101010"}
    assert model.model_validate(style).model_dump() == style
    with pytest.raises(ValidationError):
        model.model_validate({name: "c", "bg": "#101010"})


def test_a_model_is_built_once_per_schema() -> None:
    reordered = dict(reversed(list(THEME.items())))
    assert style_model("theme", THEME) is style_model("theme", reordered)
