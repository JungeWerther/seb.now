"""The follow-inbox migration on Supabase's own Postgres image, in a fresh
database shaped like production's (whose default privileges grant every new
table to anon and authenticated, which the migration must take back). Runs
where TEST_DATABASE_URL names a postgres connection to such a server (CI's
`db` job); skipped elsewhere.
"""

import json
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import errors, sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase" / "migrations" / "20261029120000_follow_inbox.sql"
PRODUCTION_SHAPE = Path(__file__).with_name("production_shape.sql")
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not SERVER_URL, reason="TEST_DATABASE_URL not set")

PAGE = "https://www.theguardian.com/profile/david-adler"
SIGNALS = {"url": PAGE, "feeds": [{"url": PAGE + "/rss"}]}


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    name = f"follow_inbox_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(PRODUCTION_SHAPE.read_text())
        with psycopg.connect(url) as conn:
            conn.execute(MIGRATION.read_text())
        yield url
    finally:
        with psycopg.connect(SERVER_URL, autocommit=True) as server:
            server.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


@pytest.fixture
def db(url: str) -> Iterator["psycopg.Connection"]:
    with psycopg.connect(url) as conn:
        yield conn
        conn.rollback()


@contextmanager
def acting_as(conn: "psycopg.Connection", role: str) -> Iterator[None]:
    """Runs the block as `role`; a failed statement leaves the transaction to
    the caller's rollback, which drops the role with it."""
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
    try:
        yield
    finally:
        if conn.info.transaction_status != psycopg.pq.TransactionStatus.INERROR:
            conn.execute("reset role")


def put(conn: "psycopg.Connection", page: str = PAGE, signals: object = SIGNALS) -> uuid.UUID:
    row = conn.execute("select public.follow_inbox_put(%s, %s)", (page, json.dumps(signals))).fetchone()
    assert row is not None
    return row[0]


def test_service_role_stages_a_page(db: "psycopg.Connection") -> None:
    with acting_as(db, "service_role"):
        inbox_id = put(db)
        row = db.execute("select status, signals from follow_inbox where id = %s", (inbox_id,)).fetchone()
    assert row == ("pending", SIGNALS)


def test_sending_a_pending_page_again_refreshes_its_row(db: "psycopg.Connection") -> None:
    with acting_as(db, "service_role"):
        first = put(db)
        second = put(db, signals={"url": PAGE, "title": "again"})
        rows = db.execute("select id, signals->>'title' from follow_inbox where page_url = %s", (PAGE,)).fetchall()
    assert first == second
    assert rows == [(first, "again")]


def test_a_processed_page_can_be_sent_again(db: "psycopg.Connection") -> None:
    with acting_as(db, "service_role"):
        first = put(db)
        db.execute("update follow_inbox set status = 'followed', processed_at = now() where id = %s", (first,))
        second = put(db)
    assert first != second


def test_recent_counts_pages_within_the_window(db: "psycopg.Connection") -> None:
    with acting_as(db, "service_role"):
        put(db)
        put(db, "https://example.com/other", {"url": "https://example.com/other"})
        db.execute("update follow_inbox set created_at = now() - interval '2 hours' where page_url = %s", (PAGE,))
        recent = db.execute("select public.follow_inbox_recent('1 hour')").fetchone()
    assert recent == (1,)


@pytest.mark.parametrize(
    ("page", "signals"),
    [
        ("http://example.com/", SIGNALS),
        ("javascript:alert(1)", SIGNALS),
        ("https://example.com/" + "a" * 2048, SIGNALS),
        (PAGE, ["not", "an", "object"]),
        (PAGE, "text"),
        (PAGE, {"blob": "x" * 200_000}),
    ],
)
def test_the_table_refuses_what_the_intake_would_never_send(
    db: "psycopg.Connection", page: str, signals: object
) -> None:
    with acting_as(db, "service_role"), pytest.raises(errors.CheckViolation):
        put(db, page, signals)


def test_status_and_processed_at_move_together(db: "psycopg.Connection") -> None:
    with acting_as(db, "service_role"):
        inbox_id = put(db)
        with pytest.raises(errors.CheckViolation):
            db.execute("update follow_inbox set status = 'followed' where id = %s", (inbox_id,))


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_the_public_roles_can_neither_read_nor_write(db: "psycopg.Connection", role: str) -> None:
    with acting_as(db, role), pytest.raises(errors.InsufficientPrivilege):
        db.execute("select * from follow_inbox")
    db.rollback()
    with acting_as(db, role), pytest.raises(errors.InsufficientPrivilege):
        put(db)
    db.rollback()
    with acting_as(db, role), pytest.raises(errors.InsufficientPrivilege):
        db.execute("select public.follow_inbox_recent('1 hour')")
