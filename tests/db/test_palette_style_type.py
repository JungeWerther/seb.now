"""The Colours style type (entity.style.palette) and its built-in style, on a database shaped like production's."""

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = tuple(
    ROOT / "supabase" / "migrations" / name
    for name in (
        "20261020120000_style_types.sql",
        "20261120120000_block_style_type.sql",
        "20261120230000_block_style_pastel_blue.sql",
        "20261121090000_palette_style_type.sql",
    )
)
PRODUCTION_SHAPE = Path(__file__).with_name("production_shape.sql")
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")
ROLES = ("text", "page", "card", "accent", "accent_soft", "muted", "muted_soft", "alert")
TOKENS = {f"color_{role}{shade}" for role in ROLES for shade in ("", "_dark")}

pytestmark = pytest.mark.skipif(not SERVER_URL, reason="TEST_DATABASE_URL not set")


@pytest.fixture(scope="module")
def db() -> Iterator["psycopg.Connection"]:
    name = f"palette_style_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(PRODUCTION_SHAPE.read_text())
        for migration in MIGRATIONS:
            with psycopg.connect(url) as conn:
                conn.execute(migration.read_text())
        with psycopg.connect(url) as conn:
            yield conn
    finally:
        with psycopg.connect(SERVER_URL, autocommit=True) as server:
            server.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


def test_the_palette_type_is_compiled_with_every_role_required(db: "psycopg.Connection") -> None:
    schema = db.execute("select schema from kinds where path = 'entity.style.palette'").fetchone()[0]
    assert set(schema["required"]) == TOKENS
    assert schema["additionalProperties"] is False


def test_the_built_in_palette_sets_every_role(db: "psycopg.Connection") -> None:
    kind, style = db.execute("select kind, style from entities where kind_path = 'entity.style.palette'").fetchone()
    assert kind == "style"
    assert set(style) == TOKENS
    assert style["color_accent"] == "#75352e"


def test_the_built_in_block_ink_is_the_ultramarine_mix(db: "psycopg.Connection") -> None:
    style = db.execute("select style from entities where kind_path = 'entity.style.block'").fetchone()[0]
    assert (style["block_ink"], style["block_ink_dark"], style["block_depth"]) == ("#333d84", "#8b90cf", "5px")


def test_a_palette_with_a_rogue_colour_is_refused(db: "psycopg.Connection") -> None:
    style = {token: "#000000" for token in TOKENS} | {"color_accent": "red;}body{x"}
    with pytest.raises(psycopg.Error):
        db.execute(
            "insert into entities (name, kind, kind_path, style) values ('bad', 'style', 'entity.style.palette', %s)",
            (psycopg.types.json.Jsonb(style),),
        )
    db.rollback()
