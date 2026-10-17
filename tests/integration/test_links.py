"""Integration test: an unauthenticated Supabase session can read the tables
the site reads, and each row is exactly its generated row type."""

from typing import get_type_hints

from pydantic import TypeAdapter

from seb_now.auth import get_unauthenticated_client
from seb_now.db_types import (
    DomainSourceTypesRow,
    EntitiesRow,
    LinkEntitiesRow,
    LinksRow,
    LinkTopicsRow,
    NaceActivitiesRow,
    SourcesRow,
    Table,
    TopicsRow,
)

PUBLIC_TABLES = (
    (Table.LINKS, LinksRow),
    (Table.TOPICS, TopicsRow),
    (Table.LINK_TOPICS, LinkTopicsRow),
    (Table.DOMAIN_SOURCE_TYPES, DomainSourceTypesRow),
    (Table.SOURCES, SourcesRow),
    (Table.NACE_ACTIVITIES, NaceActivitiesRow),
    (Table.ENTITIES, EntitiesRow),
    (Table.LINK_ENTITIES, LinkEntitiesRow),
)


def test_unauthenticated_client_has_no_user_session() -> None:
    client = get_unauthenticated_client()
    assert client.auth.get_session() is None


def test_tables_match_their_row_types() -> None:
    client = get_unauthenticated_client()

    for table, row_type in PUBLIC_TABLES:
        adapter = TypeAdapter(row_type)
        for row in client.table(table).select("*").limit(5).execute().data:
            assert set(row) == set(get_type_hints(row_type)), table
            adapter.validate_python(row)
