"""The crawlers migration on Supabase's own Postgres image, applied after the
accounts migration it builds on, in a fresh database shaped like production's
(accounts_shape.sql, then crawlers_shape.sql). Runs where TEST_DATABASE_URL
names such a server (CI's `db` job); skipped elsewhere.
"""

import json
import os
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import errors, sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = [
    ROOT / "supabase" / "migrations" / name for name in ("20261029120000_accounts.sql", "20261120120000_crawlers.sql")
]
SHAPES = [Path(__file__).with_name(name) for name in ("accounts_shape.sql", "crawlers_shape.sql")]
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not SERVER_URL, reason="TEST_DATABASE_URL not set")

GOOGLEBOT = (
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/157.0.8103.78 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
)
OAI_SEARCHBOT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 "
    "Safari/537.36; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot"
)
FIREFOX = "Mozilla/5.0 (Android 15; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0"


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    name = f"crawlers_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            for shape in SHAPES:
                conn.execute(shape.read_text())
        for migration in MIGRATIONS:
            with psycopg.connect(url) as conn:
                conn.execute(migration.read_text())
        yield url
    finally:
        with psycopg.connect(SERVER_URL, autocommit=True) as server:
            server.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


@pytest.fixture
def db(url: str) -> Iterator["psycopg.Connection"]:
    with psycopg.connect(url) as conn:
        yield conn
        conn.rollback()


def user(conn: "psycopg.Connection", user_agent: str, anonymous: bool = True) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute("insert into auth.users (id, is_anonymous) values (%s, %s)", (uid, anonymous))
    conn.execute("insert into profiles (id) values (%s)", (uid,))
    conn.execute("insert into auth.sessions (user_id, user_agent) values (%s, %s)", (uid, user_agent))
    return uid


@contextmanager
def requesting(conn: "psycopg.Connection", who: uuid.UUID, user_agent: str) -> Iterator[None]:
    """As PostgREST runs a request: the caller's role and claims, and its headers."""
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(who)}),))
    conn.execute("select set_config('request.headers', %s, true)", (json.dumps({"user-agent": user_agent}),))
    try:
        yield
    finally:
        if conn.info.transaction_status != psycopg.pq.TransactionStatus.INERROR:
            conn.execute("reset role")


def crawler(conn: "psycopg.Connection", user_agent: str | None) -> object:
    row = conn.execute("select public.is_crawler(%s)", (user_agent,)).fetchone()
    assert row is not None
    return row[0]


@contextmanager
def as_service_role(conn: "psycopg.Connection") -> Iterator[None]:
    conn.execute("set local role service_role")
    try:
        yield
    finally:
        if conn.info.transaction_status != psycopg.pq.TransactionStatus.INERROR:
            conn.execute("reset role")


def purgeable(conn: "psycopg.Connection") -> set[object]:
    with as_service_role(conn):
        return {row[0] for row in conn.execute("select user_id from public.purgeable_crawler_accounts")}


@pytest.mark.parametrize("user_agent", [GOOGLEBOT, OAI_SEARCHBOT, "Mozilla/5.0 (compatible; AhrefsBot/7.0)"])
def test_named_crawlers_are_crawlers(db: "psycopg.Connection", user_agent: str) -> None:
    assert crawler(db, user_agent) is True


@pytest.mark.parametrize("user_agent", [FIREFOX, "node", "Deno/2.1.4", "curl/8.5.0", "", None])
def test_readers_and_our_own_clients_are_not(db: "psycopg.Connection", user_agent: str | None) -> None:
    assert crawler(db, user_agent) is False


def test_a_crawler_request_records_no_signals(db: "psycopg.Connection") -> None:
    bot = user(db, GOOGLEBOT)
    link = uuid.uuid4()
    with requesting(db, bot, GOOGLEBOT), pytest.raises(errors.InsufficientPrivilege):
        db.execute("insert into link_impressions (viewer_id, link_id) values (%s, %s)", (bot, link))


@pytest.mark.parametrize(
    "insert",
    [
        "insert into link_impressions (viewer_id, link_id) values (%(who)s, gen_random_uuid())",
        "insert into link_visits (visitor_id) values (%(who)s)",
        "insert into votes (link_id, voter_id, value) values (gen_random_uuid(), %(who)s, 1)",
    ],
)
def test_every_signal_table_refuses_a_crawler(db: "psycopg.Connection", insert: str) -> None:
    bot = user(db, OAI_SEARCHBOT)
    with requesting(db, bot, OAI_SEARCHBOT), pytest.raises(errors.InsufficientPrivilege):
        db.execute(insert, {"who": bot})


def test_a_reader_still_records_signals(db: "psycopg.Connection") -> None:
    me = user(db, FIREFOX)
    with requesting(db, me, FIREFOX):
        db.execute("insert into link_impressions (viewer_id, link_id) values (%s, gen_random_uuid())", (me,))
        db.execute("insert into votes (link_id, voter_id, value) values (gen_random_uuid(), %s, 1)", (me,))


def test_only_anonymous_crawler_accounts_holding_signals_are_purgeable(db: "psycopg.Connection") -> None:
    bot = user(db, GOOGLEBOT)
    db.execute("insert into link_impressions (viewer_id, link_id) values (%s, gen_random_uuid())", (bot,))
    voter = user(db, GOOGLEBOT)
    db.execute("insert into votes (link_id, voter_id, value) values (gen_random_uuid(), %s, 1)", (voter,))
    real = user(db, GOOGLEBOT, anonymous=False)
    reader = user(db, FIREFOX)
    assert purgeable(db) == {bot}
    assert {voter, real, reader}.isdisjoint(purgeable(db))


def test_the_first_session_decides(db: "psycopg.Connection") -> None:
    me = user(db, FIREFOX)
    db.execute("insert into auth.sessions (user_id, user_agent) values (%s, %s)", (me, GOOGLEBOT))
    assert me not in purgeable(db)


def test_purging_deletes_exactly_the_purgeable_accounts_and_their_rows(db: "psycopg.Connection") -> None:
    bot = user(db, GOOGLEBOT)
    db.execute("insert into link_impressions (viewer_id, link_id) values (%s, gen_random_uuid())", (bot,))
    kept = user(db, GOOGLEBOT)
    db.execute("insert into votes (link_id, voter_id, value) values (gen_random_uuid(), %s, -1)", (kept,))
    reader = user(db, FIREFOX)
    with as_service_role(db):
        row = db.execute("select public.purge_crawler_accounts()").fetchone()
    assert row == (1,)
    remaining = {r[0] for r in db.execute("select id from auth.users")}
    assert bot not in remaining
    assert {kept, reader} <= remaining
    assert db.execute("select count(*) from link_impressions where viewer_id = %s", (bot,)).fetchone() == (0,)


def test_service_role_reads_crawler_accounts_without_access_to_auth(db: "psycopg.Connection") -> None:
    bot = user(db, GOOGLEBOT)
    db.execute("revoke all on auth.users, auth.sessions from service_role")
    with as_service_role(db):
        rows = db.execute("select user_id, user_agent from public.crawler_accounts").fetchall()
    assert (bot, GOOGLEBOT) in rows


def test_a_vote_committed_while_the_purge_waits_keeps_its_account(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as setup:
        bot = user(setup, GOOGLEBOT)
    try:
        with psycopg.connect(url) as voter, psycopg.connect(url) as purger:
            voter.execute("insert into votes (link_id, voter_id, value) values (gen_random_uuid(), %s, 1)", (bot,))
            purger.execute("set statement_timeout = '10s'")
            purger.execute("set role service_role")

            # The purge would block on the vote's key-share lock; commit the vote
            # from another thread once the purge is waiting.
            def commit_later() -> None:
                time.sleep(0.5)
                voter.commit()

            threading.Thread(target=commit_later).start()
            row = purger.execute("select public.purge_crawler_accounts()").fetchone()
            purger.commit()
        assert row == (0,)
        with psycopg.connect(url) as check:
            assert check.execute("select count(*) from auth.users where id = %s", (bot,)).fetchone() == (1,)
    finally:
        with psycopg.connect(url, autocommit=True) as cleanup:
            cleanup.execute("delete from auth.users where id = %s", (bot,))


def test_readers_cannot_purge_crawler_accounts(db: "psycopg.Connection") -> None:
    me = user(db, FIREFOX)
    with requesting(db, me, FIREFOX), pytest.raises(errors.InsufficientPrivilege):
        db.execute("select public.purge_crawler_accounts()")


def test_readers_cannot_list_crawler_accounts(db: "psycopg.Connection") -> None:
    me = user(db, FIREFOX)
    with requesting(db, me, FIREFOX), pytest.raises(errors.InsufficientPrivilege):
        db.execute("select * from public.crawler_accounts")
