"""Typed reads through PostgREST.

A read declares the row it wants as a TypedDict whose keys are the columns:
`select` turns it into the PostgREST select (a field typed as another
TypedDict, or a list of them, embeds the table it's named after), and
`validated` checks the returned rows against it. tests/test_db_types.py checks
every such TypedDict against the generated `db_types` row of its table.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import get_args, get_type_hints, is_typeddict

from postgrest.types import JSON
from pydantic import TypeAdapter


def embedded(hint: object) -> type[object] | None:
    """The TypedDict a field embeds: the field's type itself, or inside a list or optional."""
    if isinstance(hint, type) and is_typeddict(hint):
        return hint
    return next((row_type for arg in get_args(hint) if (row_type := embedded(arg))), None)


def _column(name: str, hint: object) -> str:
    row_type = embedded(hint)
    return f"{name}({select(row_type)})" if row_type else name


def select(row_type: type[object]) -> str:
    return ", ".join(_column(name, hint) for name, hint in get_type_hints(row_type).items())


def validated[Row](row_type: type[Row], data: Sequence[JSON]) -> list[Row]:
    adapter = TypeAdapter(row_type)
    return [adapter.validate_python(row) for row in data]
