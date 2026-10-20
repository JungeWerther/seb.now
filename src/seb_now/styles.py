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
from collections.abc import Mapping
from functools import cache
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, create_model

DEFS_PREFIX = "#/$defs/"


class UnsupportedSchema(ValueError):
    """A schema that uses something outside the vocabulary style types may use."""


class Style(BaseModel):
    """What every style model is: its tokens, and nothing else."""

    model_config = {"extra": "forbid", "frozen": True}


def _primitive(schema: object) -> object:
    match schema:
        case {"type": "string", "pattern": str(pattern), **rest} if not rest:
            return Annotated[str, Field(pattern=pattern)]
        case {"type": "number", "minimum": int() | float() as low, "maximum": int() | float() as high, **rest} if (
            not rest
        ):
            return Annotated[float, Field(ge=low, le=high)]
    raise UnsupportedSchema(f"a primitive is a string with a pattern or a bounded number, not {schema!r}")


def _token(token: object, defs: Mapping[str, object]) -> object:
    match token:
        case {"$ref": str(ref), **rest} if ref.startswith(DEFS_PREFIX) and set(rest) <= {"description"}:
            name = ref.removeprefix(DEFS_PREFIX)
            if name not in defs:
                raise UnsupportedSchema(f"{ref} names no primitive in $defs")
            return _primitive(defs[name])
        case {"enum": [str(), *_] as values, **rest} if all(isinstance(value, str) for value in values) and set(
            rest
        ) <= {"description"}:
            return Literal[tuple(values)]
    raise UnsupportedSchema(f"a token is a $ref to a primitive or an enum of keywords, not {token!r}")


@cache
def _model(name: str, canonical_schema: str) -> type[Style]:
    match json.loads(canonical_schema):
        case {
            "type": "object",
            "additionalProperties": False,
            "properties": dict(properties),
            "required": list(required),
            "$defs": dict(defs),
            **rest,
        } if not rest and sorted(required) == sorted(properties):
            fields: dict[str, Any] = {key: (_token(token, defs), ...) for key, token in properties.items()}
            return create_model(f"Style_{name}", __base__=Style, **fields)
    raise UnsupportedSchema("a style type's schema is a closed object of required tokens with its $defs")


def style_model(name: str, schema: Mapping[str, Any]) -> type[Style]:
    """The model of the style type `name` whose stored schema is `schema`, built once per schema."""
    return _model(name, json.dumps(schema, sort_keys=True))
