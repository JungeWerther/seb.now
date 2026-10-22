"""The card-styles migration: an author's look on their own replies, its contrast
check, and which style a profile may point at."""

import json
import uuid

import pytest

from .support import acting_as, add_style, add_type, grant_refusal, refusal

psycopg = pytest.importorskip("psycopg")

CARD = "entity.style.card"
READABLE = {"card_bg": "#1e1b4b", "card_fg": "#f5f5f4", "card_accent": "#fbbf24"}
CONTRAST_REFUSAL = "must be opaque with a contrast of at least"
PROFILE_REFUSAL = "a card style must be one of your own card styles"


def set_card_style(conn: "psycopg.Connection", user: uuid.UUID, style: uuid.UUID | None) -> None:
    conn.execute("update profiles set card_style_id = %s where id = %s", (style, user))


@pytest.mark.parametrize(
    ("a", "b", "ratio"),
    [
        pytest.param("#000000", "#ffffff", 21.0, id="black-on-white"),
        pytest.param("#ffffff", "#000000", 21.0, id="symmetric"),
        pytest.param("#777777", "#777777", 1.0, id="same"),
        pytest.param("#777777", "#ffffff", 4.48, id="grey-just-under-aa"),
        pytest.param("#767676", "#ffffff", 4.54, id="grey-just-over-aa"),
    ],
)
def test_contrast_ratio_is_wcags(db: "psycopg.Connection", a: str, b: str, ratio: float) -> None:
    assert float(db.execute("select round(contrast_ratio(%s, %s)::numeric, 2)", (a, b)).fetchone()[0]) == ratio


def test_the_card_type_is_for_authors_with_no_built_in_style(db: "psycopg.Connection") -> None:
    assert db.execute("select style_scope, schema -> 'required' from kinds where path = %s", (CARD,)).fetchone() == (
        "author",
        ["card_accent", "card_bg", "card_fg"],
    )
    assert db.execute("select style_scope from kinds where path = 'entity.style.layout'").fetchone()[0] == "page"
    assert db.execute("select count(*) from entities where kind_path = %s", (CARD,)).fetchone()[0] == 0


def test_an_author_picks_a_readable_card_style(db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        style = add_style(db, "my card", CARD, READABLE)
        set_card_style(db, owner, style)
    assert db.execute("select card_style_id from profiles where id = %s", (owner,)).fetchone()[0] == style


@pytest.mark.parametrize(
    ("change", "pair"),
    [
        pytest.param({"card_fg": "#3f3a6b"}, "card_fg (#3f3a6b) on card_bg (#1e1b4b)", id="text-too-close"),
        pytest.param({"card_accent": "#4c4590"}, "card_accent (#4c4590) on card_bg", id="accent-too-close"),
        pytest.param(
            {"card_accent": "#7a72c0"}, "card_accent (#7a72c0) on card_bg", id="name-is-text-so-3-is-not-enough"
        ),
        pytest.param({"card_bg": "#1e1b4b00"}, "on card_bg (#1e1b4b00)", id="translucent-background"),
        pytest.param({"card_fg": "#f5f5f480"}, "card_fg (#f5f5f480)", id="translucent-text"),
    ],
)
def test_a_card_style_too_low_in_contrast_is_refused(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID], change: dict[str, str], pair: str
) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        why = refusal(db, lambda: add_style(db, "low contrast", CARD, {**READABLE, **change}))
    assert CONTRAST_REFUSAL in why and pair in why


def test_a_change_to_low_contrast_is_refused(db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        style = add_style(db, "my card", CARD, READABLE)
        why = refusal(
            db,
            lambda: db.execute(
                "update entities set style = %s where id = %s", (json.dumps({**READABLE, "card_fg": "#1e1b4b"}), style)
            ),
        )
    assert CONTRAST_REFUSAL in why


def test_contrast_is_only_checked_where_a_type_declares_pairs(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]
) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        add_type(
            db, "entity.style.twotone", {"properties": {"a": {"$ref": "#/$defs/color"}, "b": {"$ref": "#/$defs/color"}}}
        )
        assert (
            refusal(db, lambda: add_style(db, "same", "entity.style.twotone", {"a": "#101010", "b": "#101010"})) == ""
        )


@pytest.mark.parametrize(
    "whose",
    [pytest.param("other", id="someone-elses"), pytest.param("layout", id="not-a-card-style")],
)
def test_a_profile_points_only_at_its_own_card_style(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID], whose: str
) -> None:
    owner, other = users
    with acting_as(db, "authenticated", other):
        others = add_style(db, "their card", CARD, READABLE)
    layout = db.execute("select id from entities where kind_path = 'entity.style.layout'").fetchone()[0]
    target = {"other": others, "layout": layout}[whose]
    with acting_as(db, "authenticated", owner):
        assert PROFILE_REFUSAL in refusal(db, lambda: set_card_style(db, owner, target))


def test_deleting_a_card_style_clears_it_from_the_profile(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]
) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        style = add_style(db, "my card", CARD, READABLE)
        set_card_style(db, owner, style)
        db.execute("delete from entities where id = %s", (style,))
    assert db.execute("select card_style_id from profiles where id = %s", (owner,)).fetchone()[0] is None


def test_readers_cannot_write_contrast_pairs_or_author_types(
    db: "psycopg.Connection", users: tuple[uuid.UUID, uuid.UUID]
) -> None:
    owner, _ = users
    with acting_as(db, "authenticated", owner):
        assert grant_refusal("style_contrast_pairs") in refusal(
            db, lambda: db.execute("delete from style_contrast_pairs where kind_path = %s", (CARD,))
        )
        assert "permission denied" in refusal(
            db,
            lambda: db.execute(
                "insert into kinds (path, label, schema, style_scope) values ('entity.style.mine', 'Mine', %s, 'author')",
                (json.dumps({"properties": {"a": {"$ref": "#/$defs/color"}}}),),
            ),
        )
    assert db.execute("select count(*) from style_contrast_pairs where kind_path = %s", (CARD,)).fetchone()[0] == 2
