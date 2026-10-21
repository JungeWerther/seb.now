"""A style type's schema, read back as a pydantic model.

The database stores every style type's schema compiled and self-contained
(20261020120000_style_types.sql): each token required, nothing else allowed,
our primitives inlined under `$defs`. `style_model` turns that schema back into
a model by interpreting a closed vocabulary, never by generating code: a token
is a `$ref` to one of the schema's `$defs` or an `enum` of keywords, and a
primitive is a string with a pattern or a number with bounds. Anything else is
refused, so a schema can only pick from what this module knows how to read.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from enum import StrEnum
from functools import cache
from typing import Annotated, Any

from pydantic import BaseModel, Field, create_model

from seb_now.constants import (
    CSS_TOKEN_PREFIX,
    DEFS_PREFIX,
    ENUM_TOKEN_STRICT,
    STYLE_TOKEN_NAME_PATTERN,
    JsonType,
    SchemaKeyword,
)


class UnsupportedSchema(ValueError):
    """A schema that uses something outside the vocabulary style types may use."""


class Style(BaseModel):
    """What every style model is: its tokens, and nothing else."""

    # Strict, as JSON Schema is: "1.5" and true aren't numbers. Tokens are
    # read and written by their own names, which are aliases, since a token
    # may be named like one of the model's own attributes (`model_config`).
    model_config = {"extra": "forbid", "frozen": True, "strict": True, "serialize_by_alias": True}


def _primitive(schema: object) -> object:
    match schema:
        case {SchemaKeyword.TYPE: JsonType.STRING, SchemaKeyword.PATTERN: str(pattern), **rest} if not rest:
            return Annotated[str, Field(pattern=pattern)]
        case {
            SchemaKeyword.TYPE: JsonType.NUMBER,
            SchemaKeyword.MINIMUM: int() | float() as low,
            SchemaKeyword.MAXIMUM: int() | float() as high,
            **rest,
        } if not rest:
            return Annotated[float, Field(ge=low, le=high)]
    raise UnsupportedSchema(f"a primitive is a string with a pattern or a bounded number, not {schema!r}")


def _keywords(name: str, values: list[str]) -> object:
    """An enum token as a StrEnum of its keywords. Members are named by position,
    so a keyword like `name` or `value` can't shadow Enum's own attributes; the
    field is lax so a keyword's plain string reads as its member."""
    keywords = StrEnum(name, [(f"v{i}", value) for i, value in enumerate(values)])  # type: ignore[misc]
    return Annotated[keywords, Field(strict=ENUM_TOKEN_STRICT)]


def _token(key: str, token: object, defs: Mapping[str, object]) -> object:
    match token:
        case {SchemaKeyword.REF: str(ref), **rest} if ref.startswith(DEFS_PREFIX) and set(rest) <= {
            SchemaKeyword.DESCRIPTION
        }:
            name = ref.removeprefix(DEFS_PREFIX)
            if name not in defs:
                raise UnsupportedSchema(f"{ref} names no primitive in $defs")
            return _primitive(defs[name])
        case {SchemaKeyword.ENUM: [str(), *_] as values, **rest} if all(
            isinstance(value, str) for value in values
        ) and set(rest) <= {SchemaKeyword.DESCRIPTION}:
            return _keywords(f"Token_{key}", values)
    raise UnsupportedSchema(f"a token is a $ref to a primitive or an enum of keywords, not {token!r}")


@cache
def _model(name: str, canonical_schema: str) -> type[Style]:
    match json.loads(canonical_schema):
        case {
            SchemaKeyword.TYPE: JsonType.OBJECT,
            SchemaKeyword.ADDITIONAL_PROPERTIES: False,
            SchemaKeyword.PROPERTIES: dict(properties),
            SchemaKeyword.REQUIRED: list(required),
            SchemaKeyword.DEFS: dict(defs),
            **rest,
        } if not rest and sorted(required) == sorted(properties):
            fields: dict[str, Any] = {
                f"token_{i}": (_token(key, token, defs), Field(alias=key))
                for i, (key, token) in enumerate(properties.items())
            }
            return create_model(f"Style_{name}", __base__=Style, **fields)
    raise UnsupportedSchema("a style type's schema is a closed object of required tokens with its $defs")


def style_model(name: str, schema: Mapping[str, Any]) -> type[Style]:
    """The model of the style type `name` whose stored schema is `schema`, built once per schema."""
    return _model(name, json.dumps(schema, sort_keys=True))


def css_property(token: str) -> str:
    """The CSS custom property a token sets: `column_width` is `--column-width`."""
    if not re.fullmatch(STYLE_TOKEN_NAME_PATTERN, token):
        raise UnsupportedSchema(f"{token!r} isn't a token name")
    return CSS_TOKEN_PREFIX + token.replace("_", "-")


def css_declarations(style: Style) -> str:
    """A validated style's tokens as custom property declarations, one per token."""
    return " ".join(f"{css_property(token)}: {value};" for token, value in style.model_dump(mode="json").items())
