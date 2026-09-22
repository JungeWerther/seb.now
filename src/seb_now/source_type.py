"""Classify a link's source type: mainstream media, YouTube long-form, or direct link.

Domain-based only — no article-body fetching or duration lookups. A URL's
host is checked against MAINSTREAM_MEDIA_DOMAINS and YOUTUBE_DOMAINS in
constants.py; anything that matches neither is a DIRECT_LINK.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Sequence
from urllib.parse import urlparse

from seb_now.constants import MAINSTREAM_MEDIA_DOMAINS, YOUTUBE_DOMAINS, SourceType


def _registrable_domain(url: str) -> str:
    host = urlparse(url).netloc.lower()
    host = host.split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def display_domain(url: str) -> str:
    """Domain for on-page display: no scheme, no www., no TLD suffix."""
    domain = _registrable_domain(url)
    return domain.rsplit(".", 1)[0] if "." in domain else domain


def classify_source(url: str) -> SourceType:
    domain = _registrable_domain(url)
    if domain in YOUTUBE_DOMAINS:
        return SourceType.YOUTUBE_LONGFORM
    if domain in MAINSTREAM_MEDIA_DOMAINS:
        return SourceType.MAINSTREAM_MEDIA
    return SourceType.DIRECT_LINK


def group_by_source_type(urls: Sequence[str]) -> dict[SourceType, list[str]]:
    groups: dict[SourceType, list[str]] = defaultdict(list)
    for url in urls:
        groups[classify_source(url)].append(url)
    return dict(groups)
