"""Named metaparameters and model identifiers, so call sites never hardcode them.

Referenced by src/seb_now/*.py. Grouped
by which file each constant belongs to; a string identifier that names an
external model gets a StrEnum member instead of a bare literal.
tests/test_constants_convention.py enforces the "no literal in a class
instantiation" half of this in CI.
"""

from __future__ import annotations

from enum import StrEnum


class SourceType(StrEnum):
    MAINSTREAM_MEDIA = "mainstream_media"
    YOUTUBE_LONGFORM = "youtube_longform"
    DIRECT_LINK = "direct_link"


# site.py — topic chips shown per article, highest-p first
ARTICLE_TOPIC_CHIPS = 2
# site.py — per-source favicon in each article's left column; {host} is the
# link's host without "www.". DuckDuckGo's service, not Google's, so a
# visitor's browser doesn't report every source it renders to Google.
FAVICON_URL_TEMPLATE = "https://icons.duckduckgo.com/ip3/{host}.ico"
# site.py — articles pre-rendered into index.html; the page loads the rest
# (and search results) from Supabase in pages of the same size as you scroll.
FEED_PAGE_SIZE = 30
# site.py — value of every field in the #article-template markup, which the
# page script overwrites per link
TEMPLATE_ARTICLE_BLANK = ""

# sanitize.py — safe_http_url
# Schemes a feed/post URL may use when rendered into an href or src.
SAFE_URL_SCHEMES: frozenset[str] = frozenset({"http", "https"})
# sanitize.py — is_safe_slug: a post slug becomes a filesystem path and a URL
# segment, so it's limited to lowercase letters, digits and inner hyphens.
POST_SLUG_PATTERN = r"[a-z0-9]+(?:-[a-z0-9]+)*"

# consent.py — where the OAuth consent page is written under dist/; must match
# the Authorization Path set in Supabase (Authentication → OAuth Server).
OAUTH_CONSENT_PATH = "oauth/consent"

# site.py — supabase-js, pinned to an exact version since the page's CSP
# trusts whatever script this origin serves.
SUPABASE_JS_MODULE_URL = "https://esm.sh/@supabase/supabase-js@2.117.2"
# site.py / posts.py — Content-Security-Policy origins for the Google Fonts
# stylesheet and the font files it references.
GOOGLE_FONTS_STYLESHEET_ORIGIN = "https://fonts.googleapis.com"
GOOGLE_FONTS_FILE_ORIGIN = "https://fonts.gstatic.com"
