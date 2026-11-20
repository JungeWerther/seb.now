"""seb.now/llms.txt: the site in markdown, for agents and crawlers.

The llmstxt.org shape: templates/llms.txt holds the title, summary and the
sections every reader has (the MCP server, the sort orders, the sources), all
site-relative since the static build doesn't know its origin; the build adds
the same newest links the page pre-renders, so a crawler reads what a visitor
sees. Titles come from arbitrary sites, so they're flattened to one line and
their brackets escaped, and URLs have the characters that would end a markdown
link percent-encoded (as UTF-8 bytes, like any URL).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

from seb_now.constants import LLMS_TXT_LINKS_HEADING, LLMS_TXT_NOTE_SEPARATOR, LLMS_TXT_PATH

TEMPLATE_PATH = Path(__file__).parent / "templates" / "llms.txt"

# Whitespace runs and control or format characters, which would break a line.
LINE_BREAKERS = re.compile(r"[\s\x00-\x1f\x7f\u200b-\u200f\u2028\u2029]+")
# What would end a markdown link text early or start a new one.
LINK_TEXT_SPECIALS = re.compile(r"([\[\]\\])")
# What would end a markdown link destination early.
LINK_URL_SPECIALS = re.compile(r"[\s()<>]")


class Named(Protocol):
    @property
    def name(self) -> str: ...


class Linkable(Protocol):
    """What llms.txt reads of a feed article (site.Article)."""

    @property
    def title(self) -> str: ...
    @property
    def url(self) -> str: ...
    @property
    def domain(self) -> str: ...
    @property
    def topics(self) -> tuple[Named, ...]: ...


def one_line(text: str) -> str:
    return LINE_BREAKERS.sub(" ", text).strip()


def link_text(text: str) -> str:
    return LINK_TEXT_SPECIALS.sub(r"\\\1", one_line(text))


def link_url(url: str) -> str:
    return LINK_URL_SPECIALS.sub(lambda m: quote(m.group(), safe=""), url)


def link_line(article: Linkable) -> str:
    topics = ", ".join(one_line(topic.name) for topic in article.topics)
    note = LLMS_TXT_NOTE_SEPARATOR.join(part for part in (one_line(article.domain), topics) if part)
    link = f"- [{link_text(article.title)}]({link_url(article.url)})"
    return f"{link}: {link_text(note)}" if note else link


def render_llms_txt(articles: Iterable[Linkable]) -> str:
    lines = tuple(map(link_line, articles))
    links = "\n".join((f"## {LLMS_TXT_LINKS_HEADING}", "", *lines)) + "\n" if lines else ""
    return "\n".join(part for part in (TEMPLATE_PATH.read_text(), links) if part)


def write_llms_txt(output_dir: Path, articles: Iterable[Linkable]) -> Path:
    path = output_dir / LLMS_TXT_PATH
    path.write_text(render_llms_txt(articles))
    return path
