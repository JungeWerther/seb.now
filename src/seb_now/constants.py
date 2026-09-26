"""Named metaparameters and model identifiers, so call sites never hardcode them.

Referenced by src/seb_now/*.py and the examples/ scripts. Grouped
by which file each constant belongs to; a string identifier that names an
external model gets a StrEnum member instead of a bare literal.
tests/test_constants_convention.py enforces the "no literal in a class
instantiation" half of this in CI.
"""

from __future__ import annotations

from enum import StrEnum


class ModelName(StrEnum):
    ALL_MINI_LM_L6_V2 = "all-MiniLM-L6-v2"


class SourceType(StrEnum):
    MAINSTREAM_MEDIA = "mainstream_media"
    YOUTUBE_LONGFORM = "youtube_longform"
    DIRECT_LINK = "direct_link"


# source_type.py — classify_source
# Domains recognized as mainstream media outlets. Anything else falls
# through to DIRECT_LINK rather than growing this list unboundedly.
MAINSTREAM_MEDIA_DOMAINS: frozenset[str] = frozenset(
    {
        "nytimes.com",
        "washingtonpost.com",
        "wsj.com",
        "bbc.com",
        "bbc.co.uk",
        "cnn.com",
        "reuters.com",
        "apnews.com",
        "theguardian.com",
        "npr.org",
        "ft.com",
        "bloomberg.com",
        "foxnews.com",
        "nbcnews.com",
        "cbsnews.com",
        "abcnews.go.com",
        "usatoday.com",
        "politico.com",
        "axios.com",
        "time.com",
        "newsweek.com",
        "economist.com",
    }
)
YOUTUBE_DOMAINS: frozenset[str] = frozenset({"youtube.com", "youtu.be"})

# site.py — topic chips shown per article, highest-p first
ARTICLE_TOPIC_CHIPS = 2
# site.py — per-source favicon in each article's left column; {host} is the
# link's host without "www.". DuckDuckGo's service, not Google's, so a
# visitor's browser doesn't report every source it renders to Google.
FAVICON_URL_TEMPLATE = "https://icons.duckduckgo.com/ip3/{host}.ico"

# examples/real_embedding_check.py
REAL_EMBEDDING_LAW_CHECK_TOLERANCE = 1e-4

# examples/train_compositional_embedding.py — TrainableEmbed + training loop
ATTENTION_EMBEDDING_DIM = 16
SELF_ATTENTION_NUM_HEADS = 1
ATTENTION_BATCH_FIRST = True
TRAINABLE_EMBED_TRAIN_STEPS = 300
TRAINABLE_EMBED_LEARNING_RATE = 0.05
TRAINABLE_EMBED_LAW_CHECK_TOLERANCE = 0.05
