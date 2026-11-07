"""The accounts migration on Supabase's own Postgres image, in a fresh database
shaped like production's (accounts_shape.sql). Runs where TEST_DATABASE_URL
names such a server (CI's `db` job); skipped elsewhere.
"""

import json
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase" / "migrations" / "20261029120000_accounts.sql"
SHAPE = Path(__file__).with_name("accounts_shape.sql")
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not SERVER_URL, reason="TEST_DATABASE_URL not set")


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    name = f"accounts_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(SHAPE.read_text())
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


def user(conn: "psycopg.Connection", anonymous: bool, handle: str | None = None) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute("insert into auth.users (id, is_anonymous) values (%s, %s)", (uid, anonymous))
    conn.execute("insert into profiles (id, handle) values (%s, %s)", (uid, handle))
    return uid


@contextmanager
def acting_as(conn: "psycopg.Connection", who: uuid.UUID | None, role: str = "authenticated") -> Iterator[None]:
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
    claims = json.dumps({"sub": str(who), "role": role} if who else {"role": role})
    conn.execute("select set_config('request.jwt.claims', %s, true)", (claims,))
    try:
        yield
    finally:
        conn.execute("reset role")


def refused(conn: "psycopg.Connection", statement: str, args: tuple = ()) -> bool:
    conn.execute("savepoint attempt")
    try:
        conn.execute(statement, args)
    except psycopg.Error:
        conn.execute("rollback to savepoint attempt")
        return True
    conn.execute("release savepoint attempt")
    return False


def one(conn: "psycopg.Connection", query: str, args: tuple = ()) -> object:
    row = conn.execute(query, args).fetchone()
    return row[0] if row else None


def test_every_user_column_is_covered(db: "psycopg.Connection") -> None:
    assert db.execute("select * from account_columns_missing").fetchall() == []


def test_credit_limit_by_tier(db: "psycopg.Connection") -> None:
    anon, account = user(db, True), user(db, False)
    assert one(db, "select query_credit_limit(%s)", (anon,)) == 1000
    assert one(db, "select query_credit_limit(%s)", (account,)) == 10000
    db.execute("insert into query_credits values (%s, 1000), (%s, 1000)", (anon, account))
    with acting_as(db, anon):
        assert one(db, "select spend_query_credit()") is None
    with acting_as(db, account):
        assert one(db, "select spend_query_credit()") == 8999
        assert one(db, "select query_credits_left()") == 8999
    with acting_as(db, None, "service_role"):
        assert one(db, "select refund_query_credit(%s)", (account,)) == 9000


def test_replies_need_an_account(db: "psycopg.Connection") -> None:
    anon, account = user(db, True), user(db, False)
    insert = "insert into replies (link_id, author_id, body) values (gen_random_uuid(), %s, 'hi')"
    with acting_as(db, anon):
        assert refused(db, insert, (anon,))
    with acting_as(db, account):
        assert not refused(db, insert, (account,))


def test_handles_need_an_account(db: "psycopg.Connection") -> None:
    anon, kept, account = user(db, True), user(db, True, "kept"), user(db, False)
    set_handle = "update profiles set handle = %s where id = %s"
    with acting_as(db, anon):
        assert refused(db, set_handle, ("newname", anon))
    with acting_as(db, kept):
        assert not refused(db, "update profiles set display_name = 'K' where id = %s", (kept,))
        assert refused(db, set_handle, ("renamed", kept))
        assert not refused(db, set_handle, (None, kept))
    with acting_as(db, account):
        assert not refused(db, set_handle, ("me", account))


def test_style_picks_need_an_account(db: "psycopg.Connection") -> None:
    anon, account = user(db, True), user(db, False)
    db.execute("insert into kinds (path) values ('entity.style.layout')")
    style = one(db, "insert into entities default values returning id")
    pick = "insert into style_picks (user_id, type_path, style_id) values (%s, 'entity.style.layout', %s)"
    with acting_as(db, anon):
        assert refused(db, pick, (anon, style))
    with acting_as(db, account):
        assert not refused(db, pick, (account, style))


def test_merge_folds_anonymous_into_account(db: "psycopg.Connection") -> None:
    anon, account = user(db, True, "anonhandle"), user(db, False)
    both, only_anon = uuid.uuid4(), uuid.uuid4()
    db.execute(
        "insert into votes (link_id, voter_id, value) values (%s, %s, 1), (%s, %s, -1), (%s, %s, 1)",
        (both, anon, both, account, only_anon, anon),
    )
    db.execute("insert into topic_overrides values (%s, 'ai', 0.9), (%s, 'ai', 0.1)", (anon, account))
    db.execute("insert into query_credits values (%s, 30), (%s, 12)", (anon, account))
    db.execute("insert into replies (link_id, author_id, body) values (%s, %s, 'kept')", (both, anon))
    db.execute("insert into follows (follower_id, followee_id) values (%s, %s)", (anon, account))
    db.execute("insert into ap_followers (actor_url, profile_id) values ('https://x/a', %s)", (anon,))

    db.execute("select merge_account(%s, %s)", (anon, account))

    votes = dict(db.execute("select link_id, value from votes where voter_id = %s", (account,)).fetchall())
    assert votes == {both: -1, only_anon: 1}
    assert one(db, "select score from topic_overrides where user_id = %s", (account,)) == pytest.approx(0.1)
    assert one(db, "select used from query_credits where user_id = %s", (account,)) == 42
    assert one(db, "select count(*) from replies where author_id = %s", (account,)) == 1
    assert one(db, "select count(*) from follows") == 0
    assert one(db, "select count(*) from ap_followers") == 0
    assert one(db, "select handle from profiles where id = %s", (account,)) == "anonhandle"
    assert one(db, "select count(*) from auth.users where id = %s", (anon,)) == 0


def test_merge_keeps_the_accounts_own_handle(db: "psycopg.Connection") -> None:
    anon, account = user(db, True, "anonhandle"), user(db, False, "mine")
    db.execute("select merge_account(%s, %s)", (anon, account))
    assert one(db, "select handle from profiles where id = %s", (account,)) == "mine"


def test_merge_refuses_wrong_directions(db: "psycopg.Connection") -> None:
    anon, other_anon, account = user(db, True), user(db, True), user(db, False)
    merge = "select merge_account(%s, %s)"
    assert refused(db, merge, (account, anon))
    assert refused(db, merge, (anon, other_anon))
    assert refused(db, merge, (anon, anon))


def test_merge_refuses_an_uncovered_column(db: "psycopg.Connection") -> None:
    anon, account = user(db, True), user(db, False)
    db.execute("create table public.forgotten (owner uuid references public.profiles (id))")
    assert refused(db, "select merge_account(%s, %s)", (anon, account))


def test_clients_cannot_merge(db: "psycopg.Connection") -> None:
    anon, account = user(db, True), user(db, False)
    with acting_as(db, account):
        assert refused(db, "select merge_account(%s, %s)", (anon, account))
