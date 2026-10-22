"""What the database tests share besides fixtures: acting as a role, adding types
and styles, and reading why a write was refused."""

import json
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import psycopg
from psycopg import sql


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


def policy_refusal(table: str) -> str:
    return f'new row violates row-level security policy for table "{table}"'


def grant_refusal(table: str) -> str:
    return f"permission denied for table {table}"
