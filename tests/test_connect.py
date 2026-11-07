import base64
import hashlib
import re
from html import unescape
from pathlib import Path

from seb_now.connect import render_connect, write_connect
from seb_now.constants import CONNECT_PATH, SUPABASE_JS_URL


def _page_script(html: str) -> str:
    match = re.search(r'<script type="module">(.*?)</script>', html, re.DOTALL)
    assert match is not None
    return match.group(1)


def test_connect_csp_only_allows_its_own_script_by_hash() -> None:
    html = render_connect(supabase_url="https://example.supabase.co", supabase_anon_key="k")

    digest = base64.b64encode(hashlib.sha256(_page_script(html).encode()).digest()).decode()
    meta = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', html)
    assert meta is not None
    directives = dict(d.strip().split(" ", 1) for d in unescape(meta.group(1)).split(";"))
    assert directives["script-src"].split() == [f"'sha256-{digest}'", SUPABASE_JS_URL]
    assert directives["connect-src"] == "https://example.supabase.co"


def test_connect_fills_every_placeholder() -> None:
    html = render_connect(supabase_url="https://example.supabase.co", supabase_anon_key="k")

    assert "__" not in _page_script(html)
    assert "__CONTENT_SECURITY_POLICY__" not in html


def test_connect_escapes_config_so_it_cannot_close_the_script() -> None:
    html = render_connect(supabase_url="https://x.example/</script><script>alert(1)</script>", supabase_anon_key="k")

    assert html.count("</script>") == 1


def test_connect_never_writes_html_and_hands_the_token_only_to_this_window() -> None:
    script = _page_script(render_connect())

    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "location.assign"):
        assert sink not in script
    assert not re.search(r"\son[a-z]+=", render_connect())
    # The token is posted to this window's own origin, never to "*" or another frame.
    assert script.count("postMessage(") == 1
    assert 'window.postMessage({ type: "seb-follow-token", nonce, ...token }, location.origin);' in script
    # An answer counts only from this window, this origin, with the same nonce.
    assert "event.source === window && event.origin === location.origin" in script
    assert "event.data.nonce === nonce" in script


def test_connect_drops_the_nonce_from_the_address() -> None:
    script = _page_script(render_connect())

    assert 'history.replaceState(null, "", location.pathname)' in script


def test_a_token_nobody_took_is_revoked() -> None:
    script = _page_script(render_connect())

    assert re.search(r"if \(!handed\) \{\s*// [^\n]*\n\s*await client\.rpc\(\"revoke_follow_token\"", script)


def test_write_connect_uses_the_configured_path(tmp_path: Path) -> None:
    path = write_connect(tmp_path, supabase_url="https://example.supabase.co", supabase_anon_key="k")

    assert path == tmp_path / CONNECT_PATH / "index.html"
    assert "request_follow_token" in path.read_text()
