"""Shared identifiers and fixed geometry of the LoRA training workflow."""

from __future__ import annotations


DATASET_SCHEMA = "lora.dataset.v1"
REVIEWS_SCHEMA = "lora.reviews.v1"
ENCODINGS_SCHEMA = "lora.encodings.v1"
REPORT_SCHEMA = "lora.training_report.v1"

DATASET_TYPE = "lora.dataset.v1"
REVIEWS_TYPE = "lora.reviews.v1"
ENCODINGS_TYPE = "lora.encodings.v1"
SOURCES_TYPE = "lora.sources.v1"
LORA_FILE_TYPE = "h3.lora.peft.v1"
REPORT_TYPE = "lora.training_report.v1"
DIRECTION_TYPE = "text.prompt.v1"
MANIFEST_TYPE = "lora.manifest.v1"
REGISTERED_TYPE = "lora.registered.v1"

# Every training clip: 22 frames at 24 fps (17n+5 frames: 7 latent frames) at 1280x736 (46x80 latents).
CLIP_FRAMES = 22
CLIP_FPS = 24
CLIP_WIDTH = 1280
CLIP_HEIGHT = 736
TOKEN_PIXELS = 32  # one DiT video token covers 2x2 latent cells of 16x16 pixels

SOURCE_ROLES = ("train", "heldout", "eval_only")
"""train: clips may be trained on; heldout: never trained, evaluation references; eval_only: never trained,
evaluation references only (for example material that must not teach the model)."""

PROVIDER_CLIPS = "media.lora_clips"
PROVIDER_REVIEW = "qwen_vl.clip_review"
PROVIDER_TRAIN = "h3.lora_train"
PROVIDER_REGISTER = "lora.register"
PROVIDER_CONDITIONING = "h3.conditioning"
PROVIDER_VIDEO_ENCODE = "h3.video_encode"
PROVIDER_AUDIO_ENCODE = "h3.audio_encode"
PROVIDER_DIT = "h3.dit"

__all__ = [
    "CLIP_FPS",
    "CLIP_FRAMES",
    "CLIP_HEIGHT",
    "CLIP_WIDTH",
    "DATASET_SCHEMA",
    "DATASET_TYPE",
    "DIRECTION_TYPE",
    "ENCODINGS_SCHEMA",
    "ENCODINGS_TYPE",
    "LORA_FILE_TYPE",
    "MANIFEST_TYPE",
    "PROVIDER_AUDIO_ENCODE",
    "PROVIDER_CLIPS",
    "PROVIDER_CONDITIONING",
    "PROVIDER_DIT",
    "PROVIDER_REGISTER",
    "PROVIDER_REVIEW",
    "PROVIDER_TRAIN",
    "PROVIDER_VIDEO_ENCODE",
    "REGISTERED_TYPE",
    "REPORT_SCHEMA",
    "REPORT_TYPE",
    "REVIEWS_SCHEMA",
    "REVIEWS_TYPE",
    "SOURCES_TYPE",
    "SOURCE_ROLES",
    "TOKEN_PIXELS",
]
