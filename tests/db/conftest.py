"""Fixtures for the database tests: Supabase's own Postgres image (pg_jsonschema and
the anon/authenticated roles), a fresh database shaped like production's, with
every migration under test applied in order. Runs where TEST_DATABASE_URL names a
postgres connection to such a server (CI's `db` job); skipped elsewhere.
"""

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = [
    ROOT / "supabase" / "migrations" / name
    for name in ("20261020120000_style_types.sql", "20261022180000_card_styles.sql")
]
PRODUCTION_SHAPE = Path(__file__).with_name("production_shape.sql")
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    if not SERVER_URL:
        for item in items:
            item.add_marker(pytest.mark.skip(reason="TEST_DATABASE_URL not set"))


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    name = f"style_types_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(PRODUCTION_SHAPE.read_text())
        # Each in a session of its own, as CI's migrate job runs them: nothing
        # a migration needs is loaded yet.
        for migration in MIGRATIONS:
            with psycopg.connect(url) as conn:
                conn.execute(migration.read_text())
        yield url
    finally:
        with psycopg.connect(SERVER_URL, autocommit=True) as server:
            server.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


@pytest.fixture(scope="module")
def users(url: str) -> tuple[uuid.UUID, uuid.UUID]:
    owner, other = uuid.uuid4(), uuid.uuid4()
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("insert into auth.users (id) values (%s), (%s)", (owner, other))
        conn.execute("insert into profiles (id) values (%s), (%s)", (owner, other))
    return owner, other


@pytest.fixture
def db(url: str) -> Iterator["psycopg.Connection"]:
    with psycopg.connect(url) as conn:
        yield conn
        conn.rollback()
