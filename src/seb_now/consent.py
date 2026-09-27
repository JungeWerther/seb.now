"""The OAuth consent page Supabase Auth sends people to when an app (an MCP
client, say) asks to act as them. Supabase runs the OAuth server; this page
only shows the request and approves or denies it with supabase-js, as the
browser's own session.
"""

from __future__ import annotations

from html import escape
from pathlib import Path

from seb_now.constants import OAUTH_CONSENT_PATH, SUPABASE_JS_MODULE_URL
from seb_now.sanitize import page_csp, script_json

TEMPLATE_PATH = Path(__file__).parent / "templates" / "consent.html"


def render_consent(*, supabase_url: str = "", supabase_anon_key: str = "") -> str:
    html = TEMPLATE_PATH.read_text()
    html = html.replace("__SUPABASE_URL__", script_json(supabase_url))
    html = html.replace("__SUPABASE_ANON_KEY__", script_json(supabase_anon_key))
    html = html.replace("__SUPABASE_JS_MODULE_URL__", script_json(SUPABASE_JS_MODULE_URL))
    return html.replace("__CONTENT_SECURITY_POLICY__", escape(page_csp(html, supabase_url)))


def write_consent(output_dir: Path, *, supabase_url: str, supabase_anon_key: str) -> Path:
    path = output_dir / OAUTH_CONSENT_PATH / "index.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_consent(supabase_url=supabase_url, supabase_anon_key=supabase_anon_key))
    return path
