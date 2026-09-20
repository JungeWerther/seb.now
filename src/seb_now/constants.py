"""Named metaparameters and model identifiers, so call sites never hardcode them.

Referenced by src/seb_now/clustering.py and the examples/ scripts. Grouped
by which file each constant belongs to; a string identifier that names an
external model gets a StrEnum member instead of a bare literal.
tests/test_constants_convention.py enforces the "no literal in a class
instantiation" half of this in CI.
"""

from __future__ import annotations

from enum import StrEnum


class ModelName(StrEnum):
    ALL_MINI_LM_L6_V2 = "all-MiniLM-L6-v2"


# clustering.py — TopicClusterer
DEFAULT_SIMILARITY_THRESHOLD = 0.5

# examples/cluster_articles.py
BAG_OF_WORDS_SIMILARITY_THRESHOLD = 0.2

# examples/real_embedding_check.py
REAL_EMBEDDING_LAW_CHECK_TOLERANCE = 1e-4

# examples/train_compositional_embedding.py — TrainableEmbed + training loop
ATTENTION_EMBEDDING_DIM = 16
SELF_ATTENTION_NUM_HEADS = 1
ATTENTION_BATCH_FIRST = True
TRAINABLE_EMBED_TRAIN_STEPS = 300
TRAINABLE_EMBED_LEARNING_RATE = 0.05
TRAINABLE_EMBED_LAW_CHECK_TOLERANCE = 0.05

# examples/cluster_articles_semantic.py — skip-gram training + clustering
SKIPGRAM_EMBEDDING_DIM = 8
SKIPGRAM_WINDOW = 3
SKIPGRAM_EPOCHS = 800
SKIPGRAM_LEARNING_RATE = 0.05
SKIPGRAM_LAW_CHECK_TOLERANCE = 1e-4
SKIPGRAM_SIMILARITY_THRESHOLD = 0.3
SKIPGRAM_NEAREST_WORDS_TOP_K = 4

# site.py — render_site CLI default output directory
DEFAULT_SITE_OUTPUT_DIR = "dist"

# site.py — fetch_headlines / build_vocab
FEED_FETCH_TIMEOUT_SECONDS = 8
HEADLINES_PER_FEED_LIMIT = 8
SITE_VOCAB_MAX_SIZE = 40
SITE_VOCAB_MIN_WORD_LENGTH = 4


class NewsFeed(StrEnum):
    """Public RSS feeds fetched at build time to populate the homepage."""

    BBC_WORLD = "https://feeds.bbci.co.uk/news/world/rss.xml"
    NPR_WORLD = "https://feeds.npr.org/1004/rss.xml"
    HACKER_NEWS_FRONT_PAGE = "https://news.ycombinator.com/rss"
    TECHCRUNCH = "https://techcrunch.com/feed/"
