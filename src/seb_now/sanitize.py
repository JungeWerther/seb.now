"""Guards for database strings rendered into HTML at build time.

`html.escape` covers text and attribute contexts but not URL schemes
(`javascript:` survives escaping), HTML produced by markdown, or JSON
embedded in a <script>. The Content-Security-Policy built here is the
backstop if one of these is ever missed: no inline script runs unless its
hash is listed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from urllib.parse import urlsplit

import markdown
import nh3

from seb_now.constants import (
    GOOGLE_FONTS_FILE_ORIGIN,
    GOOGLE_FONTS_STYLESHEET_ORIGIN,
    POST_SLUG_PATTERN,
    SAFE_URL_SCHEMES,
)

_SCRIPT_JSON_ESCAPES = {"<": "\\u003c", ">": "\\u003e", "&": "\\u0026", " ": "\\u2028", " ": "\\u2029"}


def safe_http_url(url: str | None) -> str | None:
    if not url:
        return None
    scheme = urlsplit(url.strip()).scheme.lower()
    return url if scheme in SAFE_URL_SCHEMES else None


def render_markdown(text: str, extensions: list[str]) -> str:
    return nh3.clean(markdown.markdown(text, extensions=extensions))


def is_safe_slug(slug: str) -> bool:
    return re.fullmatch(POST_SLUG_PATTERN, slug) is not None


def script_json(value: object) -> str:
    """JSON for a JS literal inside an inline <script>: can't close the tag."""
    return re.sub("[<>&  ]", lambda m: _SCRIPT_JSON_ESCAPES[m.group()], json.dumps(value))


def script_hash(script: str) -> str:
    digest = hashlib.sha256(script.encode()).digest()
    return f"'sha256-{base64.b64encode(digest).decode()}'"


def content_security_policy(*, script_src: list[str], connect_src: list[str]) -> str:
    directives = {
        "default-src": ["'none'"],
        "script-src": script_src or ["'none'"],
        "connect-src": connect_src or ["'none'"],
        "img-src": ["https:", "data:"],
        "style-src": ["'unsafe-inline'", GOOGLE_FONTS_STYLESHEET_ORIGIN],
        "font-src": [GOOGLE_FONTS_FILE_ORIGIN],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
    }
    return "; ".join(f"{name} {' '.join(sources)}" for name, sources in directives.items())
