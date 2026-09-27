"""Named metaparameters and model identifiers for the research/ scripts.

The research counterpart of src/seb_now/constants.py, under the same rule
(tests/test_constants_convention.py scans research/ too).
"""

from __future__ import annotations

from enum import StrEnum


class ModelName(StrEnum):
    ALL_MINI_LM_L6_V2 = "all-MiniLM-L6-v2"


# real_embedding_check.py
REAL_EMBEDDING_LAW_CHECK_TOLERANCE = 1e-4

# train_compositional_embedding.py — TrainableEmbed + training loop
ATTENTION_EMBEDDING_DIM = 16
SELF_ATTENTION_NUM_HEADS = 1
ATTENTION_BATCH_FIRST = True
TRAINABLE_EMBED_TRAIN_STEPS = 300
TRAINABLE_EMBED_LEARNING_RATE = 0.05
TRAINABLE_EMBED_LAW_CHECK_TOLERANCE = 0.05
