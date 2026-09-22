"""Integration test: an unauthenticated Supabase session can read every
domain table, and each row matches its model."""

from seb_now.auth import get_unauthenticated_client
from seb_now.domain.models import Link

MODELS = (Link,)


def test_unauthenticated_client_has_no_user_session() -> None:
    client = get_unauthenticated_client()
    assert client.auth.get_session() is None


def test_tables_match_their_models() -> None:
    client = get_unauthenticated_client()

    for model in MODELS:
        response = client.table(model.__tablename__).select("*").limit(5).execute()
        for row in response.data:
            model.model_validate(row)
