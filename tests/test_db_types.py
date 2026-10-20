"""Rows are typed from the schema.

Every PostgREST read in src/seb_now (`.table(Table.X).select(select(SomeRow))`)
declares its row as a TypedDict; each of its fields must have exactly the type
the generated `db_types` row of that table gives the column, and an embedded
TypedDict is checked against the table its field is named after. The generator
itself and the mypy plugin that keeps string keys off plain dicts are tested
here too.
"""

import ast
import importlib
import sys
from pathlib import Path
from textwrap import dedent
from typing import get_type_hints

import pytest
from mypy import api as mypy_api

from seb_now import db_types
from seb_now.db_types import Table
from seb_now.rows import embedded, select

REPO_ROOT = Path(__file__).parent.parent
SRC_DIR = REPO_ROOT / "src" / "seb_now"
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import gen_db_types  # noqa: E402


def _reads(path: Path) -> list[tuple[str, str]]:
    """(table member, row type name) for every `.table(Table.X).select(select(Row))` in a module."""
    return [
        (table.attr, row.id)
        for node in ast.walk(ast.parse(path.read_text()))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "select"
        and isinstance(builder := node.func.value, ast.Call)
        and isinstance(builder.func, ast.Attribute)
        and builder.func.attr == "table"
        and isinstance(table := builder.args[0], ast.Attribute)
        and node.args
        and isinstance(projection := node.args[0], ast.Call)
        and isinstance(projection.func, ast.Name)
        and projection.func.id == "select"
        and isinstance(row := projection.args[0], ast.Name)
    ]


READS = [(path.stem, table, row) for path in sorted(SRC_DIR.glob("*.py")) for table, row in _reads(path)]


def _mismatches(row_type: type, table: Table) -> list[str]:
    columns = get_type_hints(getattr(db_types, gen_db_types.row_class(table)))
    found = []
    for name, hint in get_type_hints(row_type).items():
        if (nested := embedded(hint)) is not None:
            found += _mismatches(nested, Table(name)) if name in Table else [f"{table}: no table {name} to embed"]
        elif name not in columns:
            found.append(f"{table}.{name}: no such column")
        elif hint != columns[name]:
            found.append(f"{table}.{name}: {hint} but the column is {columns[name]}")
    return found


def test_the_site_reads_through_typed_rows() -> None:
    assert {(module, row) for module, _, row in READS} >= {
        ("site", "FeedRow"),
        ("site", "DomainSourceTypeRow"),
        ("posts", "PostRow"),
    }


@pytest.mark.parametrize(("module", "table", "row"), READS)
def test_each_read_row_matches_its_table(module: str, table: str, row: str) -> None:
    row_type = getattr(importlib.import_module(f"seb_now.{module}"), row)
    assert _mismatches(row_type, Table[table]) == []


def test_mismatched_rows_are_reported() -> None:
    from typing import TypedDict

    class Wrong(TypedDict):
        title: int
        nope: str
        topics: list[db_types.TopicsRow]

    assert _mismatches(Wrong, Table.LINKS) == [
        "links.title: <class 'int'> but the column is <class 'str'>",
        "links.nope: no such column",
    ]


def test_select_embeds_nested_rows() -> None:
    from seb_now.site import FeedRow

    assert select(FeedRow) == (
        "id, title, url, image_url, author, created_at, "
        "link_topics(p, topics(id, name)), link_entities(p, found_in, entities(id, name))"
    )


def test_generator_renders_a_typed_dict_per_table() -> None:
    columns = [
        gen_db_types.Column("link_topics", "topic_id", False, "ltree"),
        gen_db_types.Column("link_topics", "p", False, "float4"),
        gen_db_types.Column("links", "id", False, "uuid"),
        gen_db_types.Column("links", "tags", True, "_text"),
        gen_db_types.Column("links", "meta", True, "jsonb"),
    ]

    rendered = gen_db_types.render(columns)

    assert 'class Table(StrEnum):\n    LINK_TOPICS = "link_topics"\n    LINKS = "links"\n' in rendered
    assert "class LinkTopicsRow(TypedDict):\n    topic_id: str\n    p: float\n" in rendered
    assert "class LinksRow(TypedDict):\n    id: str\n    tags: list[str] | None\n    meta: Json | None\n" in rendered


def test_generator_refuses_unknown_types() -> None:
    with pytest.raises(SystemExit, match="geometry"):
        gen_db_types.render([gen_db_types.Column("places", "shape", False, "geometry")])


def test_mypy_plugin_refuses_string_keys_on_plain_dicts(tmp_path: Path) -> None:
    source = tmp_path / "probe.py"
    source.write_text(
        dedent(
            """
            from collections.abc import Mapping
            from typing import TypedDict

            class Row(TypedDict):
                title: str

            def read(row: Row, record: dict[str, str], mapping: Mapping[str, str], key: str) -> list[object]:
                return [
                    row["title"],
                    row.get("title"),
                    record[key],
                    record["title"],
                    record.get("title"),
                    mapping["title"],
                ]
            """
        )
    )

    stdout, _, status = mypy_api.run(
        ["--strict", "--no-incremental", f"--config-file={REPO_ROOT / 'pyproject.toml'}", str(source)]
    )

    assert status == 1
    assert stdout.count("[typed-rows]") == 3, stdout
