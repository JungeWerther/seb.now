"""The follow-tokens migration on Supabase's own Postgres image, applied after
the accounts and follow-inbox migrations it builds on, in a fresh database
shaped like production's (accounts_shape.sql). Runs where TEST_DATABASE_URL
names such a server (CI's `db` job); skipped elsewhere.
"""

import hashlib
import json
import os
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import errors, sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = [
    ROOT / "supabase" / "migrations" / name
    for name in ("20261029120000_accounts.sql", "20261029130000_follow_inbox.sql", "20261029140000_follow_tokens.sql")
]
SHAPE = Path(__file__).with_name("accounts_shape.sql")
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not SERVER_URL, reason="TEST_DATABASE_URL not set")

TOKEN = re.compile(r"^sft_[0-9a-f]{64}$")
CODE = re.compile(r"^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$")
PAGE = "https://www.theguardian.com/profile/david-adler"


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    name = f"follow_tokens_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(SHAPE.read_text())
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


def user(conn: "psycopg.Connection", anonymous: bool = True) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute("insert into auth.users (id, is_anonymous) values (%s, %s)", (uid, anonymous))
    conn.execute("insert into profiles (id) values (%s)", (uid,))
    return uid


@contextmanager
def acting_as(conn: "psycopg.Connection", who: uuid.UUID | None, role: str = "authenticated") -> Iterator[None]:
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
    claims = json.dumps({"sub": str(who), "role": role} if who else {"role": role})
    conn.execute("select set_config('request.jwt.claims', %s, true)", (claims,))
    try:
        yield
    finally:
        if conn.info.transaction_status != psycopg.pq.TransactionStatus.INERROR:
            conn.execute("reset role")


def request(conn: "psycopg.Connection", who: uuid.UUID, label: str = "Firefox on Android") -> dict[str, object]:
    with acting_as(conn, who):
        cur = conn.execute("select * from public.request_follow_token(%s)", (label,))
        row = cur.fetchone()
    assert row is not None and cur.description is not None
    return dict(zip([c.name for c in cur.description], row, strict=True))


def owner(conn: "psycopg.Connection", token: object) -> tuple[object, ...] | None:
    with acting_as(conn, None, "service_role"):
        return conn.execute("select user_id, status from public.follow_token_owner(%s)", (token,)).fetchone()


def approve(conn: "psycopg.Connection", code: object) -> object:
    with acting_as(conn, None, "service_role"):
        row = conn.execute("select public.approve_follow_token(%s)", (code,)).fetchone()
    assert row is not None
    return row[0]


def test_an_unknown_anonymous_account_waits_with_a_pairing_code(db: "psycopg.Connection") -> None:
    me = user(db)
    issued = request(db, me)
    assert TOKEN.match(str(issued["token"]))
    assert issued["status"] == "pending"
    assert CODE.match(str(issued["pair_code"]))
    assert owner(db, issued["token"]) == (me, "pending")


def test_only_the_tokens_hash_is_stored(db: "psycopg.Connection") -> None:
    issued = request(db, user(db))
    stored = db.execute("select token_hash from follow_tokens where id = %s", (issued["token_id"],)).fetchone()
    assert stored == (hashlib.sha256(str(issued["token"]).encode()).digest(),)
    leaked = db.execute("select count(*) from follow_tokens t where strpos(t::text, %s) > 0", (issued["token"],))
    assert leaked.fetchone() == (0,)


def test_approving_the_code_allows_the_account_and_its_pending_devices(db: "psycopg.Connection") -> None:
    me = user(db)
    phone, laptop = request(db, me), request(db, me, "Chrome")
    assert approve(db, str(phone["pair_code"]).lower().replace("-", " ")) == me
    assert owner(db, phone["token"]) == (me, "active")
    assert owner(db, laptop["token"]) == (me, "active")
    # Allowed now: the next device is active at once, with no code.
    tablet = request(db, me, "Tablet")
    assert (tablet["status"], tablet["pair_code"]) == ("active", None)


def test_an_unknown_code_approves_nothing(db: "psycopg.Connection") -> None:
    request(db, user(db))
    assert approve(db, "ZZZ-ZZZ") is None
    assert approve(db, "") is None


def test_a_real_account_is_allowed_without_approval(db: "psycopg.Connection") -> None:
    issued = request(db, user(db, anonymous=False))
    assert (issued["status"], issued["pair_code"]) == ("active", None)


def test_using_a_token_records_it_and_unknown_tokens_have_no_owner(db: "psycopg.Connection") -> None:
    me = user(db, anonymous=False)
    issued = request(db, me)
    assert owner(db, issued["token"]) == (me, "active")
    used = db.execute("select last_used_at is not null from follow_tokens where id = %s", (issued["token_id"],))
    assert used.fetchone() == (True,)
    assert owner(db, "sft_" + "0" * 64) is None
    assert owner(db, "") is None


def test_a_revoked_token_stops_working_and_only_its_owner_can_revoke_it(db: "psycopg.Connection") -> None:
    me, someone = user(db, anonymous=False), user(db)
    issued = request(db, me)
    with acting_as(db, someone):
        assert db.execute("select public.revoke_follow_token(%s)", (issued["token_id"],)).fetchone() == (False,)
    assert owner(db, issued["token"]) == (me, "active")
    with acting_as(db, me):
        assert db.execute("select public.revoke_follow_token(%s)", (issued["token_id"],)).fetchone() == (True,)
        assert db.execute("select count(*) from public.my_follow_tokens()").fetchone() == (0,)
    assert owner(db, issued["token"]) == (me, "revoked")


def test_a_reader_lists_only_their_own_devices_without_hashes(db: "psycopg.Connection") -> None:
    me, someone = user(db), user(db)
    request(db, me)
    request(db, someone)
    with acting_as(db, me):
        cur = db.execute("select * from public.my_follow_tokens()")
        rows = cur.fetchall()
        assert cur.description is not None
        columns = [c.name for c in cur.description]
    assert len(rows) == 1
    assert "token_hash" not in columns


def test_at_most_five_devices_wait_per_account(db: "psycopg.Connection") -> None:
    me = user(db)
    for _ in range(5):
        request(db, me)
    with acting_as(db, me), pytest.raises(errors.RaiseException, match="waiting for approval"):
        db.execute("select * from public.request_follow_token('one more')")


def test_signing_in_is_required(db: "psycopg.Connection") -> None:
    with acting_as(db, None), pytest.raises(errors.RaiseException, match="sign in"):
        db.execute("select * from public.request_follow_token('x')")


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_clients_reach_no_table_and_no_service_function(db: "psycopg.Connection", role: str) -> None:
    me = user(db)
    for statement in [
        "select * from follow_tokens",
        "select * from follow_curators",
        "select * from follow_inbox",
        "select public.approve_follow_token('AAA-AAA')",
        "select * from public.follow_token_owner('x')",
        f"select public.follow_inbox_put('{me}', 'https://example.com/', '{{}}')",
    ]:
        with acting_as(db, me, role), pytest.raises(errors.InsufficientPrivilege):
            db.execute(statement)
        db.rollback()


def test_the_anon_role_cannot_ask_for_a_token(db: "psycopg.Connection") -> None:
    with acting_as(db, None, "anon"), pytest.raises(errors.InsufficientPrivilege):
        db.execute("select * from public.request_follow_token('x')")


def test_each_account_has_its_own_pending_pages_and_rate(db: "psycopg.Connection") -> None:
    me, someone = user(db), user(db)
    with acting_as(db, None, "service_role"):
        put = "select public.follow_inbox_put(%s, %s, '{}')"
        mine = db.execute(put, (me, PAGE)).fetchone()
        again = db.execute(put, (me, PAGE)).fetchone()
        theirs = db.execute(put, (someone, PAGE)).fetchone()
        assert mine == again != theirs
        assert db.execute("select public.follow_inbox_recent(%s, '1 hour')", (me,)).fetchone() == (1,)


def test_merging_an_anonymous_account_brings_its_devices_and_standing(db: "psycopg.Connection") -> None:
    anonymous, real = user(db), user(db, anonymous=False)
    issued = request(db, anonymous)
    approve(db, issued["pair_code"])
    with acting_as(db, None, "service_role"):
        db.execute("select public.follow_inbox_put(%s, %s, '{}')", (anonymous, PAGE))
        assert db.execute("select count(*) from public.account_columns_missing").fetchone() == (0,)
        db.execute("select public.merge_account(%s, %s)", (anonymous, real))
    assert owner(db, issued["token"]) == (real, "active")
    assert db.execute("select owner_id from follow_inbox").fetchall() == [(real,)]
    assert db.execute("select user_id from follow_curators").fetchall() == [(real,)]
