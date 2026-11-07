"""seb.now/connect: where the follow browser extension's Connect button opens.

As the browser's own session (anonymous or real, the same account as the feed)
it asks the database for a follow token (request_follow_token) and hands it to
the extension's content script, which only runs on this page and only accepts a
token carrying the one-time nonce the extension put in the address
(`#nonce=…`). A token whose account isn't allowed to send pages yet comes with a
pairing code, which the page shows until it is approved. Opened without a
nonce, it lists this account's connected devices, each revocable.
"""

from __future__ import annotations

from html import escape
from pathlib import Path

from seb_now.constants import CONNECT_PATH, SUPABASE_JS_INTEGRITY, SUPABASE_JS_URL
from seb_now.sanitize import page_csp, script_json

TEMPLATE_PATH = Path(__file__).parent / "templates" / "connect.html"


def render_connect(*, supabase_url: str = "", supabase_anon_key: str = "") -> str:
    html = TEMPLATE_PATH.read_text()
    html = html.replace("__SUPABASE_URL__", script_json(supabase_url))
    html = html.replace("__SUPABASE_ANON_KEY__", script_json(supabase_anon_key))
    html = html.replace("__SUPABASE_JS_URL__", script_json(SUPABASE_JS_URL))
    html = html.replace("__SUPABASE_JS_INTEGRITY__", script_json(SUPABASE_JS_INTEGRITY))
    return html.replace("__CONTENT_SECURITY_POLICY__", escape(page_csp(html, supabase_url)))


def write_connect(output_dir: Path, *, supabase_url: str, supabase_anon_key: str) -> Path:
    path = output_dir / CONNECT_PATH / "index.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_connect(supabase_url=supabase_url, supabase_anon_key=supabase_anon_key))
    return path
