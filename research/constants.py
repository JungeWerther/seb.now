"""Named metaparameters and model identifiers for the research/ scripts.

The research counterpart of src/seb_now/constants.py, under the same rule
(tests/test_constants_convention.py scans research/ too).
"""

from __future__ import annotations

from enum import StrEnum


class ModelName(StrEnum):
    ALL_MINI_LM_L6_V2 = "all-MiniLM-L6-v2"
    MULTILINGUAL_E5_SMALL = "intfloat/multilingual-e5-small"


# real_embedding_check.py
REAL_EMBEDDING_LAW_CHECK_TOLERANCE = 1e-4

# train_compositional_embedding.py — TrainableEmbed + training loop
ATTENTION_EMBEDDING_DIM = 16
SELF_ATTENTION_NUM_HEADS = 1
ATTENTION_BATCH_FIRST = True
TRAINABLE_EMBED_TRAIN_STEPS = 300
TRAINABLE_EMBED_LEARNING_RATE = 0.05
TRAINABLE_EMBED_LAW_CHECK_TOLERANCE = 0.05

# kind_probe.py — linear probe for entity kinds from bare names
KIND_PROBE_PAGE_SIZE = 1000  # PostgREST's max rows per request
KIND_PROBE_EXCLUDED_ROOT = "entity.source"  # kind set by origin, not by the name
KIND_PROBE_MIN_EXAMPLES = 20  # a kind needs this many names at a depth to be probed
KIND_PROBE_TEST_FRACTION = 0.2
KIND_PROBE_SEED = 0
KIND_PROBE_C = 1.0  # logistic regression inverse regularisation strength
KIND_PROBE_MAX_ITER = 2000
KIND_PROBE_CLASS_WEIGHT = "balanced"  # kinds are imbalanced (persons outnumber events 8:1); weigh each kind equally
KIND_PROBE_TOP_CONFUSIONS = 10
KIND_PROBE_EMBED_BATCH = 256
E5_INPUT_PREFIX = "query: "  # e5 models expect a "query: "/"passage: " prefix
CHAR_NGRAM_ANALYZER = "char_wb"
CHAR_NGRAM_MIN = 2
CHAR_NGRAM_MAX = 4
CHAR_NGRAM_LOWERCASE = False  # capitalisation is part of the signal

# kind_predicates.py — one yes/no probe per kind
KIND_PREDICATE_THRESHOLD = 0.5  # a predicate "fires" at or above this probability
KIND_PREDICATE_TOP_COMBOS = 6
