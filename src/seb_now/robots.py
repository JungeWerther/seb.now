"""seb.now/robots.txt: everyone welcome, except the crawlers it names.

templates/robots.txt holds the comment and the `User-agent: *` group that lets
every other reader in; the build adds one group naming every crawler whose
`crawler_agents.robots_disallow` is set (20261126200000_crawler_robots.sql),
disallowed the whole site. Who is turned away is data, so changing it is a row
update and a rebuild, not a code change. Tokens come from a table only
service_role writes, but each is still checked to be a bare product token, so
no value can start a line of its own.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

from seb_now.constants import ROBOTS_TXT_DISALLOW_ALL, ROBOTS_TXT_PATH

TEMPLATE_PATH = Path(__file__).parent / "templates" / "robots.txt"

# A user-agent product token (RFC 9309 §2.2.1): letters, digits, "_" and "-".
PRODUCT_TOKEN = re.compile(r"[A-Za-z0-9_-]+")


def product_token(token: str) -> str:
    if not PRODUCT_TOKEN.fullmatch(token):
        raise ValueError(f"not a robots.txt product token: {token!r}")
    return token


def disallow_group(tokens: Iterable[str]) -> str:
    agents = tuple(f"User-agent: {product_token(token)}" for token in sorted(set(tokens)))
    return "\n".join((*agents, ROBOTS_TXT_DISALLOW_ALL)) + "\n" if agents else ""


def render_robots_txt(disallowed: Iterable[str]) -> str:
    """The template, then the disallowed crawlers' group (a crawler obeys the
    group naming it over `*`, so the order is only for readers)."""
    return "\n".join(part for part in (TEMPLATE_PATH.read_text(), disallow_group(disallowed)) if part)


def write_robots_txt(output_dir: Path, disallowed: Iterable[str]) -> Path:
    path = output_dir / ROBOTS_TXT_PATH
    path.write_text(render_robots_txt(disallowed))
    return path
