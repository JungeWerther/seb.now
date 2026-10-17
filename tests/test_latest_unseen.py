"""SEB-15: "new"/"latest" puts the links the reader has already seen last.

The behaviour itself is checked on an embedded Postgres by
`tests/qa/latest_unseen_db.mjs` (`npm run latest` there) and the query reading
by `npm run page`; these are the static invariants CI can hold without Node.
"""

import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
MIGRATION = ROOT / "supabase" / "migrations" / "20261017231500_latest_unseen_first.sql"
INDEX_HTML = ROOT / "src" / "seb_now" / "templates" / "index.html"


def _sql() -> str:
    return MIGRATION.read_text()


def _page() -> str:
    return INDEX_HTML.read_text()


def test_migration_only_adds() -> None:
    sql = re.sub(r"--[^\n]*", "", _sql()).lower()
    for destructive in (
        "drop table",
        "drop column",
        "delete from",
        "truncate table",
        "truncate public",
        "alter column",
    ):
        assert destructive not in sql, destructive


def test_impressions_are_private_to_their_viewer() -> None:
    sql = _sql()
    assert "alter table public.link_impressions enable row level security" in sql
    assert sql.count("(select auth.uid()) = viewer_id") == 2
    assert "revoke all on public.link_impressions from anon" in sql


def test_feed_query_stays_security_invoker() -> None:
    sql = _sql()
    assert "security invoker" in sql
    assert "security definer" not in sql


def test_latest_puts_seen_last_as_of_the_feed_start() -> None:
    sql = _sql()
    assert "sort = 'latest' and viewer is not null" in sql
    assert "lv.visited_at <= as_of" in sql
    assert "li.seen_at <= as_of" in sql
    assert re.search(r"order by o\.mentions desc, o\.seen, o\.rank desc", sql)


def test_new_reads_as_latest() -> None:
    page = _page()
    assert re.search(r'\bnew: "latest"', page)
    assert 'QUERY_NAME_OPENING_SORT_WORDS = new Set(["new"])' in page


def test_page_records_seen_rows_and_queries_latest_as_the_reader() -> None:
    page = _page()
    assert '.from("link_impressions").upsert(' in page
    assert "observeSeen(visible);" in page
    assert (
        'if (intent.sort === "for_you" || intent.sort === "latest") await pendingSession;'
        in page
    )
