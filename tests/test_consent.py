import base64
import hashlib
import re
from html import unescape
from pathlib import Path

from seb_now.consent import render_consent, write_consent
from seb_now.constants import OAUTH_CONSENT_PATH


def _page_script(html: str) -> str:
    return re.search(r'<script type="module">(.*?)</script>', html, re.DOTALL).group(1)


def test_consent_csp_only_allows_its_own_script_by_hash() -> None:
    html = render_consent(supabase_url="https://example.supabase.co", supabase_anon_key="k")

    digest = base64.b64encode(hashlib.sha256(_page_script(html).encode()).digest()).decode()
    csp = unescape(re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', html).group(1))
    directives = dict(d.strip().split(" ", 1) for d in csp.split(";"))
    assert directives["script-src"].split() == [f"'sha256-{digest}'", "https://esm.sh"]
    assert directives["connect-src"] == "https://example.supabase.co"


def test_consent_fills_every_placeholder() -> None:
    html = render_consent(supabase_url="https://example.supabase.co", supabase_anon_key="k")

    assert "__" not in _page_script(html).replace("__proto__", "")
    assert "__CONTENT_SECURITY_POLICY__" not in html


def test_consent_escapes_config_so_it_cannot_close_the_script() -> None:
    html = render_consent(supabase_url="https://x.example/</script><script>alert(1)</script>", supabase_anon_key="k")

    assert html.count("</script>") == 1


def test_consent_script_never_writes_html_and_only_follows_web_redirects() -> None:
    script = _page_script(render_consent())

    assert "innerHTML" not in script
    assert "outerHTML" not in script
    assert "insertAdjacentHTML" not in script
    assert "document.write" not in script
    assert not re.search(r"\son[a-z]+=", render_consent())
    assert script.count("location.assign(") == 1
    assert "if (parseHttpUrl(value)) location.assign(value);" in script


def test_write_consent_uses_the_configured_path(tmp_path: Path) -> None:
    path = write_consent(tmp_path, supabase_url="https://example.supabase.co", supabase_anon_key="k")

    assert path == tmp_path / OAUTH_CONSENT_PATH / "index.html"
    assert "approveAuthorization" in path.read_text()
