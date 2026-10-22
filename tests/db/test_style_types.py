"""The style-types migration: types, styles, their checks and who may write them."""

import json
import threading
import uuid

import pytest

from .support import acting_as, add_style, add_type, grant_refusal, policy_refusal, refusal

psycopg = pytest.importorskip("psycopg")

THEME = {"properties": {"bg": {"$ref": "#/$defs/color"}, "density": {"enum": ["compact", "roomy"]}}}
DARK = {"bg": "#101010", "density": "compact"}


META_REFUSAL = "needs a schema of named primitives or enums"
STYLE_REFUSAL = "doesn't match the schema of"


def test_seeded_layout_is_a_compiled_type_with_its_style(db: "psycopg.Connection") -> None:
    schema = db.execute("select schema from kinds where path = 'entity.style.layout'").fetchone()[0]
    assert schema["required"] == ["column_width", "dock_width"]
    assert schema["additionalProperties"] is False
    assert set(schema["$defs"]) == {"color", "length", "duration", "number", "font"}
    assert db.execute("select kind, style from entities where kind_path = 'entity.style.layout'").fetchone() == (
        "style",
        {"column_width": "720px", "dock_width": "480px"},
    )


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
        pytest.param(
            "entity.style.bad",
            "Bad",
            {"properties": {"x": {"type": "string", "pattern": "(a+)+$"}}},
            META_REFUSAL,
            id="own-pattern",
        ),
        pytest.param(
            "entity.style.bad",
            "Bad",
            {"properties": {"x": {"$ref": "https://evil.example/s.json"}}},
            META_REFUSAL,
            id="remote-ref",
        ),
        pytest.param(
            "entity.style.bad",
            "Bad",
            {"properties": {"x": {"$ref": "#/$defs/color", "pattern": "(a+)+$"}}},
            META_REFUSAL,
            id="ref-with-pattern",
        ),
        pytest.param(
            "entity.style.bad",
            "Bad",
            {"properties": {"x": {"$ref": "#/$defs/nope"}}},
            META_REFUSAL,
            id="unknown-primitive",
        ),
        pytest.param(
            "entity.style.bad",
            "Bad",
            {"properties": {"x": {"type": "object", "properties": {}}}},
            META_REFUSAL,
            id="nesting",
        ),
        pytest.param("entity.style.bad", "Bad", {"properties": {}}, META_REFUSAL, id="no-tokens"),
        pytest.param(
            "entity.style.bad",
            "Bad",
            {"properties": {"Bad-Name": {"$ref": "#/$defs/color"}}},
            META_REFUSAL,
            id="token-name",
        ),
        pytest.param(
            "entity.style.bad", "Bad", {"properties": {"x": {"enum": ["a;b"]}}}, META_REFUSAL, id="enum-value"
        ),
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
        assert (
            db.execute(
                "update entities set style = %s where id = %s", (json.dumps({**DARK, "density": "roomy"}), style)
            ).rowcount
            == 1
        )
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
        pytest.param(
            "authenticated",
            "insert into entities (name, kind, kind_path) values ('Fake Co', 'company', 'entity.agent.org.company')",
            policy_refusal("entities"),
            id="extracted-entity",
        ),
        pytest.param(
            "authenticated",
            "update entities set name = 'Renamed' where kind = 'company'",
            grant_refusal("entities"),
            id="rename-entity",
        ),
        pytest.param("authenticated", "truncate kinds cascade", grant_refusal("kinds"), id="truncate-kinds"),
        pytest.param(
            "anon",
            'insert into kinds (path, label, schema) values (\'entity.style.anon\', \'Anon\', \'{"properties": {"a": {"$ref": "#/$defs/color"}}}\')',
            grant_refusal("kinds"),
            id="anon-type",
        ),
        pytest.param(
            "anon",
            'insert into entities (name, kind_path, style) values (\'Anon\', \'entity.style.layout\', \'{"column_width": "1px", "dock_width": "1px"}\')',
            grant_refusal("entities"),
            id="anon-style",
        ),
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
    assert [row[2] for row in db.execute("select * from match_entities(array['dark', 'matter', 'labs'])")] == [
        "company"
    ]
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


PARITY_TYPE = {
    "properties": {
        "bg": {"$ref": "#/$defs/color"},
        "weight": {"$ref": "#/$defs/number"},
        "model_config": {"enum": ["compact", "roomy"]},
    }
}
PARITY_STYLE = {"bg": "#101010", "weight": 1.5, "model_config": "compact"}


@pytest.mark.parametrize(
    ("token", "value"),
    [
        pytest.param("bg", "#1a2b3c", id="colour"),
        pytest.param("bg", "#1a2b3c80", id="colour-with-alpha"),
        pytest.param("bg", "#1A2B3C", id="uppercase-colour"),
        pytest.param("bg", "red", id="named-colour"),
        pytest.param("bg", "url(https://x)", id="url"),
        pytest.param("bg", "#101010;}", id="breakout"),
        pytest.param("bg", "", id="empty"),
        pytest.param("bg", 7, id="number-as-colour"),
        pytest.param("weight", 2, id="integer"),
        pytest.param("weight", -10000, id="lowest"),
        pytest.param("weight", 10000.5, id="above-maximum"),
        pytest.param("weight", "1.5", id="number-as-string"),
        pytest.param("weight", True, id="boolean"),
        pytest.param("weight", None, id="null"),
        pytest.param("model_config", "roomy", id="attribute-named-token"),
        pytest.param("model_config", "tight", id="attribute-named-token-not-in-enum"),
    ],
)
def test_python_reads_a_type_as_the_database_does(db: "psycopg.Connection", token: str, value: object) -> None:
    from seb_now.styles import style_model

    schema = db.execute("select style_type_schema(%s)", (json.dumps(PARITY_TYPE),)).fetchone()[0]
    style = {**PARITY_STYLE, token: value}
    in_database = db.execute(
        "select extensions.jsonb_matches_schema(%s::json, %s)", (json.dumps(schema), json.dumps(style))
    ).fetchone()[0]
    try:
        style_model("parity", schema).model_validate(style)
        in_python = True
    except ValueError:
        in_python = False
    assert in_python == in_database
