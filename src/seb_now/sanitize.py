"""Guards for database strings rendered into HTML at build time.

`html.escape` covers text and attribute contexts but not URL schemes
(`javascript:` survives escaping) or HTML produced by markdown.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import markdown
import nh3

from seb_now.constants import SAFE_URL_SCHEMES


def safe_http_url(url: str | None) -> str | None:
    if not url:
        return None
    scheme = urlsplit(url.strip()).scheme.lower()
    return url if scheme in SAFE_URL_SCHEMES else None


def render_markdown(text: str, extensions: list[str]) -> str:
    return nh3.clean(markdown.markdown(text, extensions=extensions))
