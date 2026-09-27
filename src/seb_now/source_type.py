"""Classify a link's source type: mainstream media, YouTube long-form, or direct link.

Domain-based only — no article-body fetching or duration lookups. A URL's
host is looked up in a domain -> SourceType mapping (the
`public.domain_source_types` table, loaded by site.py at build time);
anything not in it is a DIRECT_LINK.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Mapping, Sequence
from urllib.parse import urlparse

from seb_now.constants import SourceType


def _registrable_domain(url: str) -> str:
    host = urlparse(url).netloc.lower()
    host = host.split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def favicon_host(url: str) -> str:
    """Host to fetch a favicon for: lowercased, no www., no port or userinfo."""
    return _registrable_domain(url)


def display_domain(url: str) -> str:
    """Domain for on-page display: no scheme, no www., no TLD suffix."""
    domain = _registrable_domain(url)
    return domain.rsplit(".", 1)[0] if "." in domain else domain


def classify_source(url: str, domain_source_types: Mapping[str, SourceType]) -> SourceType:
    return domain_source_types.get(_registrable_domain(url), SourceType.DIRECT_LINK)


def group_by_source_type(
    urls: Sequence[str], domain_source_types: Mapping[str, SourceType]
) -> dict[SourceType, list[str]]:
    groups: dict[SourceType, list[str]] = defaultdict(list)
    for url in urls:
        groups[classify_source(url, domain_source_types)].append(url)
    return dict(groups)
