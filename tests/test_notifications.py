import re
from pathlib import Path

from seb_now.site import render

MIGRATION = Path(__file__).parent.parent / "supabase/migrations/20261017234700_notifications.sql"
ACTIVITYPUB = Path(__file__).parent.parent / "supabase/functions/activitypub/index.ts"


def _page_script(html: str) -> str:
    return html[html.index('<script type="module">') :]


def _function(script: str, name: str) -> str:
    start = script.index(f"function {name}(")
    end = script.index("\n    }\n", start)
    return script[start:end]


def test_notifications_are_private_to_their_recipient_and_written_only_by_the_trigger() -> None:
    sql = MIGRATION.read_text()

    assert "alter table public.notifications enable row level security;" in sql
    assert sql.count("recipient_id = auth.uid()") >= 3
    assert "revoke all on public.notifications from anon, authenticated;" in sql
    grants = re.findall(r"^grant (.+) on public\.notifications to (\w+);$", sql, re.M)
    assert grants == [("select", "authenticated"), ("update (read_at)", "authenticated")]
    assert "for insert" not in sql and "for delete" not in sql
    assert re.search(r"create function public\.notify_reply\(\).*?security definer", sql, re.S)
    assert "revoke execute on function public.notify_reply() from public, anon, authenticated;" in sql
    assert "after insert on public.replies" in sql


def test_notifications_dedupe_on_a_unique_index_not_a_constraint() -> None:
    # A unique constraint over recipient_id and reply_id would read to PostgREST
    # as a profiles<->replies many-to-many, making replies' profiles(handle) embed
    # ambiguous.
    sql = MIGRATION.read_text()

    assert (
        "create unique index notifications_recipient_reply_key on public.notifications (recipient_id, reply_id);" in sql
    )
    assert not re.search(r"unique\s*\(\s*recipient_id", sql)
    assert sql.count("on conflict (recipient_id, reply_id) do nothing") == 2


def test_page_kinds_match_the_migrations_check() -> None:
    sql = MIGRATION.read_text()
    script = _page_script(render([]))

    kinds = set(re.findall(r"'(\w+)'", re.search(r"kind in \(([^)]*)\)", sql).group(1)))
    phrases = re.search(r"const NOTIFICATION_PHRASES = \{([^}]*)\}", script).group(1)
    assert set(re.findall(r"(\w+):", phrases)) == kinds


def test_menu_has_an_inbox_bubble_with_unread_count_and_dots() -> None:
    html = render([])

    button = html[html.index('<button id="menu-btn"') : html.index("</button>", html.index('<button id="menu-btn"'))]
    assert '<span class="unread-dot" id="menu-unread-dot" hidden></span>' in button
    start = html.index('<ul id="menu-bubbles">')
    menu = html[start : html.index("</ul>", start)]
    assert 'id="inbox-bubble" data-overlay="inbox-overlay"' in menu
    assert 'id="inbox-count"' in menu and 'class="unread-dot" hidden' in menu
    assert '<dialog id="inbox-overlay" class="overlay"' in html
    assert '"inbox-overlay": loadInbox' in _page_script(html)


def test_inbox_renders_with_text_content_and_marks_only_what_it_showed_read() -> None:
    script = _page_script(render([]))

    render_fn = _function(script, "renderNotification")
    assert "innerHTML" not in render_fn
    assert "what.textContent =" in render_fn and "body.textContent =" in render_fn
    assert "focusLink(reply.link_id)" in render_fn

    load_fn = _function(script, "loadInbox")
    assert 'markRead: "mark_notifications_read"' in script
    assert "rpc(NOTIFICATIONS.markRead, { ids: unreadIds })" in load_fn
    assert "loadUnreadCount();" in load_fn
    assert 'table: "notifications", id: "id", readAt: "read_at"' in script
    assert (
        ".select(NOTIFICATIONS.id, { count: NOTIFICATIONS.exactCount, head: true }).is(NOTIFICATIONS.readAt, null)"
        in script
    )
    assert "setupInbox();" in script


def test_remote_replies_record_which_of_our_replies_they_answer() -> None:
    source = ACTIVITYPUB.read_text()

    assert "in_reply_to_id: await ourReplyId(note.inReplyTo)" in source
    start = source.index("async function ourReplyId(")
    assert 'eq("ap_state", "sent")' in source[start : source.index("\n}\n", start)]
