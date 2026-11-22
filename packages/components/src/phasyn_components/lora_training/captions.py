"""Training captions built from a clip review: shot size, camera move and action, never an identity.

A LoRA trained here learns a style or a kind of motion, not a character. Captions therefore describe the shot,
the camera and the action, refer to people generically, and never carry names, titles or the features that
identify one character (hair or eye colour). :func:`identity_problems` finds what slipped through the review
model's instructions; a clip whose caption has a problem is dropped instead of being trained on.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any


SHOTS = ("extreme close-up", "close-up", "medium", "wide", "extreme wide")
CAMERAS = {
    "static": "a fixed camera",
    "pan": "the camera pans",
    "tilt": "the camera tilts",
    "zoom in": "the camera pushes in",
    "zoom out": "the camera pulls back",
    "tracking": "the camera tracks the motion",
    "shake": "the camera shakes with the impact",
    "rotate": "the camera rotates around the action",
}
STYLES = ("2d animation", "3d cg", "live action", "mixed", "title card")
TRAINABLE_STYLES = ("2d animation", "mixed")

_COLOURS = (
    "black|white|silver|grey|gray|blonde|blond|red|pink|purple|violet|blue|green|"
    "orange|yellow|brown|golden|teal|cyan"
)
_IDENTITY_PATTERNS = (
    re.compile(rf"\b(?:{_COLOURS})[- ]?(?:haired|hair|eyes|eyed)\b", re.IGNORECASE),
    re.compile(r"\b(?:named|called|known as)\b", re.IGNORECASE),
    re.compile(r"\b(?:watermark|subtitles?|logo|caption text)\b", re.IGNORECASE),
    re.compile(r"[\"“”「」『』]"),
)
_ALLOWED_CAPITALS = frozenset({"I", "2D", "3D", "CG"})
# words that may open a sentence of a generic caption; any other capitalised opener is treated as a name
_STARTERS = frozenset(
    [
        "a",
        "an",
        "the",
        "one",
        "two",
        "three",
        "four",
        "five",
        "several",
        "many",
        "both",
        "each",
        "another",
        "some",
        "someone",
        "everyone",
        "people",
        "person",
        "figure",
        "figures",
        "man",
        "men",
        "woman",
        "women",
        "girl",
        "girls",
        "boy",
        "boys",
        "child",
        "children",
        "young",
        "old",
        "fighter",
        "fighters",
        "warrior",
        "warriors",
        "he",
        "she",
        "they",
        "it",
        "his",
        "her",
        "their",
        "its",
        "this",
        "that",
        "these",
        "those",
        "there",
        "here",
        "camera",
        "shot",
        "scene",
        "view",
        "close",
        "wide",
        "medium",
        "extreme",
        "in",
        "on",
        "at",
        "as",
        "with",
        "from",
        "after",
        "before",
        "while",
        "when",
        "then",
        "during",
        "over",
        "under",
        "behind",
        "through",
        "across",
        "into",
        "against",
        "suddenly",
        "meanwhile",
        "nearby",
        "above",
        "below",
        "inside",
        "outside",
        "light",
        "lights",
        "smoke",
        "dust",
        "sparks",
        "debris",
        "blood",
        "fire",
        "flames",
        "water",
        "rain",
        "snow",
        "wind",
        "energy",
        "speed",
        "impact",
        "shadows",
        "shadow",
        "background",
        "foreground",
        "animated",
        "hand",
        "hands",
        "arms",
        "legs",
        "body",
        "bodies",
        "swords",
        "sword",
        "blade",
        "blades",
        "weapons",
        "weapon",
    ]
)
_VERB_LIKE = ("ing", "ed", "ly")
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'-]*")
_SENTENCE_END = re.compile(r"[.!?]\s*$")
HOLD_TWOS, HOLD_THREES = 0.35, 0.6


def timing_phrase(hold_share: float | None) -> str:
    """Name hand-drawn timing only where the clip really holds drawings (no interpolation is ever added)."""
    if hold_share is None:
        return ""
    if hold_share >= HOLD_THREES:
        return " Animated on threes with held drawings."
    if hold_share >= HOLD_TWOS:
        return " Animated on twos."
    return ""


def build_caption(
    review: Mapping[str, Any], *, hold_share: float | None, prefix: str = ""
) -> str:
    """Assemble the training caption: optional prefix, shot size, camera move, the action, the timing."""
    shot = str(review.get("shot") or "medium").lower()
    if shot not in SHOTS:
        shot = "medium"
    camera = CAMERAS.get(
        str(review.get("camera") or "static").lower(), CAMERAS["static"]
    )
    body = str(review.get("caption") or "").strip().rstrip(".")
    head = f"{prefix.strip().rstrip(',')}, " if prefix.strip() else ""
    text = (
        f"{head}{shot} shot, {camera}. {body}."
        if body
        else f"{head}{shot} shot, {camera}."
    )
    return text + timing_phrase(hold_share)


def identity_problems(caption: str) -> list[str]:
    """Identity leaks in a caption: names or titles (proper nouns), colours of hair or eyes, on-screen text."""
    problems = [p.pattern for p in _IDENTITY_PATTERNS if p.search(caption)]
    for sentence in re.split(r"(?<=[.!?,;:])\s+", caption):
        words = _WORD.findall(sentence)
        if words and _suspicious_opener(words[0]):
            problems.append(f"proper noun: {words[0]}")
        for word in words[1:]:
            if word[0].isupper() and word not in _ALLOWED_CAPITALS:
                problems.append(f"proper noun: {word}")
                break
    return problems


def _suspicious_opener(word: str) -> bool:
    """A capitalised sentence opener that is neither a common caption word nor verb-like (a likely name)."""
    low = word.lower()
    return (
        word[0].isupper()
        and word not in _ALLOWED_CAPITALS
        and low not in _STARTERS
        and not low.endswith(_VERB_LIKE)
    )


def review_problems(review: Mapping[str, Any]) -> list[str]:
    """Why a reviewed clip cannot be trained on: not drawn animation, large text, no usable caption."""
    out: list[str] = []
    style = str(review.get("style") or "").lower()
    if style not in TRAINABLE_STYLES:
        out.append(f"style:{style or 'unknown'}")
    if review.get("big_text") is True:
        out.append("big_text")
    if not str(review.get("caption") or "").strip():
        out.append("no_caption")
    return out


def ends_sentence(text: str) -> bool:
    """Whether the caption ends a sentence (used to join edited captions cleanly)."""
    return bool(_SENTENCE_END.search(text))


__all__ = [
    "CAMERAS",
    "SHOTS",
    "STYLES",
    "TRAINABLE_STYLES",
    "build_caption",
    "ends_sentence",
    "identity_problems",
    "review_problems",
    "timing_phrase",
]
