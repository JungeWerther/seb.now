"""The style-types migration on Supabase's own Postgres image (pg_jsonschema and
the anon/authenticated roles), in a fresh database shaped like production's.
Runs where TEST_DATABASE_URL names a postgres connection to such a server
(CI's `db` job); skipped elsewhere.
"""

import json
import os
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import sql  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase" / "migrations" / "20261020120000_style_types.sql"
PRODUCTION_SHAPE = Path(__file__).with_name("production_shape.sql")
SERVER_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not SERVER_URL, reason="TEST_DATABASE_URL not set")

THEME = {"properties": {"bg": {"$ref": "#/$defs/color"}, "density": {"enum": ["compact", "roomy"]}}}
DARK = {"bg": "#101010", "density": "compact"}


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    name = f"style_types_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(SERVER_URL, autocommit=True) as server:
        server.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = psycopg.conninfo.make_conninfo(SERVER_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(PRODUCTION_SHAPE.read_text())
        # A session of its own, as CI's migrate job has: nothing it needs is
        # loaded yet.
        with psycopg.connect(url) as conn:
            conn.execute(MIGRATION.read_text())
        yield url
    finally:
        with psycopg.connect(SERVER_URL, autocommit=True) as server:
            server.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


@pytest.fixture(scope="module")
def users(url: str) -> tuple[uuid.UUID, uuid.UUID]:
    owner, other = uuid.uuid4(), uuid.uuid4()
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("insert into auth.users (id) values (%s), (%s)", (owner, other))
    return owner, other


@pytest.fixture
def db(url: str) -> Iterator["psycopg.Connection"]:
    with psycopg.connect(url) as conn:
        yield conn
        conn.rollback()


@contextmanager
def acting_as(conn: "psycopg.Connection", role: str, user: uuid.UUID | None = None) -> Iterator[None]:
    """Runs the block as a PostgREST request would: the role, and the JWT's claims."""
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
    claims = json.dumps({"sub": str(user), "role": role} if user else {"role": role})
    conn.execute("select set_config('request.jwt.claims', %s, true)", (claims,))
    try:
        yield
    finally:
        conn.execute("reset role")


def add_type(conn: "psycopg.Connection", path: str, schema: object, label: str = "Theme") -> None:
    conn.execute("insert into kinds (path, label, schema) values (%s, %s, %s)", (path, label, json.dumps(schema)))


def add_style(conn: "psycopg.Connection", name: str, kind_path: str, style: object) -> uuid.UUID:
    return conn.execute(
        "insert into entities (name, kind_path, style) values (%s, %s, %s) returning id",
        (name, kind_path, json.dumps(style)),
    ).fetchone()[0]


def refusal(conn: "psycopg.Connection", write: Callable[[], object]) -> str:
    """Why the write was refused ("" when it wasn't), leaving the transaction usable."""
    try:
        with conn.transaction():
            write()
    except psycopg.Error as error:
        return str(error)
    return ""


META_REFUSAL = "needs a schema of named primitives or enums"
STYLE_REFUSAL = "doesn't match the schema of"


def policy_refusal(table: str) -> str:
    return f'new row violates row-level security policy for table "{table}"'


def grant_refusal(table: str) -> str:
    return f"permission denied for table {table}"


def test_seeded_layout_is_a_compiled_type_with_its_style(db: "psycopg.Connection") -> None:
    schema = db.execute("select schema from kinds where path = 'entity.style.layout'").fetchone()[0]
    assert schema["required"] == ["column_width", "dock_width"]
    assert schema["additionalProperties"] is False
    assert set(schema["$defs"]) == {"color", "length", "duration", "number", "font"}
    assert db.execute(
        "select kind, style from entities where kind_path = 'entity.style.layout'"
    ).fetchone() == ("style", {"column_width": "720px", "dock_width": "480px"})


def test_a_reader_adds_a_type_and_a_style_of_it(db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        add_type(db, "entity.style.theme", THEME)
        style = add_style(db, "My dark", "entity.style.theme", DARK)
    assert db.execute("select owner_id from kinds where path = 'entity.style.theme'").fetchone()[0] == owner
    assert db.execute("select kind, owner_id from entities where id = %s", (style,)).fetchone() == ("style", owner)
    assert db.execute("select count(*) from identity_witnesses where entity_id = %s", (style,)).fetchone()[0] == 0


@pytest.mark.parametrize(
    ("path", "label", "schema", "reason"),
    [
        pytest.param("entity.style.bad", "Bad", {"properties": {"x": {"type": "string", "pattern": "(a+)+$"}}}, META_REFUSAL, id="own-pattern"),
        pytest.param("entity.style.bad", "Bad", {"properties": {"x": {"$ref": "https://evil.example/s.json"}}}, META_REFUSAL, id="remote-ref"),
        pytest.param("entity.style.bad", "Bad", {"properties": {"x": {"$ref": "#/$defs/color", "pattern": "(a+)+$"}}}, META_REFUSAL, id="ref-with-pattern"),
        pytest.param("entity.style.bad", "Bad", {"properties": {"x": {"$ref": "#/$defs/nope"}}}, META_REFUSAL, id="unknown-primitive"),
        pytest.param("entity.style.bad", "Bad", {"properties": {"x": {"type": "object", "properties": {}}}}, META_REFUSAL, id="nesting"),
        pytest.param("entity.style.bad", "Bad", {"properties": {}}, META_REFUSAL, id="no-tokens"),
        pytest.param("entity.style.bad", "Bad", {"properties": {"Bad-Name": {"$ref": "#/$defs/color"}}}, META_REFUSAL, id="token-name"),
        pytest.param("entity.style.bad", "Bad", {"properties": {"x": {"enum": ["a;b"]}}}, META_REFUSAL, id="enum-value"),
        pytest.param("entity.style.bad", "Bad", {**THEME, "$defs": {"color": {}}}, META_REFUSAL, id="own-defs"),
        pytest.param("entity.style.bad", "<b>", THEME, "style type labels", id="label"),
        pytest.param("entity.style.a.b", "Deep", THEME, policy_refusal("kinds"), id="too-deep"),
        pytest.param("entity.agent.evil", "Evil", None, policy_refusal("kinds"), id="outside-style"),
    ],
)
def test_a_reader_cannot_add_this_type(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID], path: str, label: str, schema: object, reason: str
) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        assert reason in refusal(db, lambda: add_type(db, path, schema, label))


@pytest.mark.parametrize(
    "style",
    [
        pytest.param({"bg": "url(https://x/?leak)", "density": "compact"}, id="url-value"),
        pytest.param({"bg": "#101010;}body{", "density": "compact"}, id="breakout"),
        pytest.param({"bg": "#101010", "density": "tight"}, id="not-in-enum"),
        pytest.param({"bg": "#101010"}, id="missing-token"),
        pytest.param({**DARK, "x": "1"}, id="extra-token"),
        pytest.param(None, id="no-style"),
    ],
)
def test_a_style_must_match_its_type(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID], style: object
) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        add_type(db, "entity.style.theme", THEME)
        assert STYLE_REFUSAL in refusal(db, lambda: add_style(db, "Bad", "entity.style.theme", style))


def test_readers_change_only_their_own_styles(db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]) -> None:
    owner, other = users
    with acting_as(db, "authenticated", owner):
        add_type(db, "entity.style.theme", THEME)
        style = add_style(db, "My dark", "entity.style.theme", DARK)
        assert db.execute(
            "update entities set style = %s where id = %s", (json.dumps({**DARK, "density": "roomy"}), style)
        ).rowcount == 1
        assert grant_refusal("entities") in refusal(
            db, lambda: db.execute("update entities set name = 'Renamed' where id = %s", (style,))
        )
        assert grant_refusal("kinds") in refusal(
            db, lambda: db.execute("update kinds set schema = '{}' where path = 'entity.style.theme'")
        )
    with acting_as(db, "authenticated", other):
        assert db.execute("update entities set style = %s where id = %s", (json.dumps(DARK), style)).rowcount == 0
        assert db.execute("delete from entities where id = %s", (style,)).rowcount == 0
        assert db.execute("delete from kinds where path = 'entity.style.theme'").rowcount == 0
    with acting_as(db, "authenticated", owner):
        assert db.execute("delete from entities where id = %s", (style,)).rowcount == 1


@pytest.mark.parametrize(
    ("role", "statement", "reason"),
    [
        pytest.param("authenticated", "insert into entities (name, kind, kind_path) values ('Fake Co', 'company', 'entity.agent.org.company')", policy_refusal("entities"), id="extracted-entity"),
        pytest.param("authenticated", "update entities set name = 'Renamed' where kind = 'company'", grant_refusal("entities"), id="rename-entity"),
        pytest.param("authenticated", "truncate kinds cascade", grant_refusal("kinds"), id="truncate-kinds"),
        pytest.param("anon", "insert into kinds (path, label, schema) values ('entity.style.anon', 'Anon', '{\"properties\": {\"a\": {\"$ref\": \"#/$defs/color\"}}}')", grant_refusal("kinds"), id="anon-type"),
        pytest.param("anon", "insert into entities (name, kind_path, style) values ('Anon', 'entity.style.layout', '{\"column_width\": \"1px\", \"dock_width\": \"1px\"}')", grant_refusal("entities"), id="anon-style"),
    ],
)
def test_writes_outside_styles_stay_closed(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID], role: str, statement: str, reason: str
) -> None:
    owner, _ = users
    with acting_as(db, role, owner if role == "authenticated" else None):
        assert reason in refusal(db, lambda: db.execute(statement))


def test_styles_are_not_names_for_anything(db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        add_type(db, "entity.style.theme", THEME)
        add_style(db, "Dark Matter Labs", "entity.style.theme", DARK)
    gen_before = db.execute("select gen from index_state").fetchone()[0]
    assert [row[1] for row in db.execute("select * from match_entities(array['dark', 'matter', 'labs'])")] == [
        "Dark Matter Labs"
    ]
    assert [row[2] for row in db.execute("select * from match_entities(array['dark', 'matter', 'labs'])")] == ["company"]
    assert [row[2] for row in db.execute("select * from entity_candidates('Dark Matter Labs')")] == ["company"]
    assert db.execute("select known_names(array['dark'])").fetchone()[0] == ["Dark Matter Labs"]
    with acting_as(db, "authenticated", owner):
        db.execute("delete from entities where kind = 'style' and owner_id = %s", (owner,))
    assert db.execute("select gen from index_state").fetchone()[0] == gen_before


def test_concurrent_inserts_cannot_pass_the_style_quota(url: str, users: tuple[uuid.UUID, uuid.UUID]) -> None:
    owner, _ = users
    with psycopg.connect(url, autocommit=True) as setup:
        quota = setup.execute("select styles_per_user()").fetchone()[0]
        setup.execute(
            "insert into kinds (path, label, schema, owner_id) values ('entity.style.quota', 'Quota', %s, %s)",
            (json.dumps(THEME), owner),
        )
        for n in range(quota - 1):
            setup.execute(
                "insert into entities (name, kind_path, style, owner_id) values (%s, 'entity.style.quota', %s, %s)",
                (f"style {n}", json.dumps(DARK), owner),
            )
    barrier = threading.Barrier(2)
    outcomes: list[bool] = []

    def insert_last(name: str) -> None:
        with psycopg.connect(url) as conn:
            with acting_as(conn, "authenticated", owner):
                barrier.wait()
                outcomes.append(not refusal(conn, lambda: add_style(conn, name, "entity.style.quota", DARK)))
            conn.commit()

    racers = [threading.Thread(target=insert_last, args=(name,)) for name in ("racer a", "racer b")]
    for racer in racers:
        racer.start()
    for racer in racers:
        racer.join()
    try:
        assert sorted(outcomes) == [False, True]
        with psycopg.connect(url) as conn:
            assert conn.execute("select count(*) from entities where owner_id = %s", (owner,)).fetchone()[0] == quota
    finally:
        with psycopg.connect(url, autocommit=True) as cleanup:
            cleanup.execute("delete from entities where kind_path = 'entity.style.quota'")
            cleanup.execute("delete from kinds where path = 'entity.style.quota'")
