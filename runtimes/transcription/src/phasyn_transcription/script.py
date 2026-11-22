"""Write Chinese transcripts in the requested script (Traditional or Simplified).

Whisper writes Chinese in whichever script it drifts into, so two runs of the same clip can come back once in
Traditional and once in Simplified characters. With ``chinese_script`` set and the recognized language Chinese, every
cue is converted deterministically with OpenCC when the runtime has it (``s2twp``: Taiwan Traditional with Taiwan
phrasing; ``t2s`` for Simplified). Without OpenCC the decoder is only steered with a prompt in the requested script,
which is usually but not always followed; the transcript records which of the two was used.
"""

from __future__ import annotations

from importlib import import_module
from importlib.util import find_spec
from typing import TYPE_CHECKING, Any, Literal


if TYPE_CHECKING:
    from collections.abc import Callable


Script = Literal["traditional", "simplified"]
Conversion = Literal["opencc", "prompt", "none"]

# OpenCC configurations: Simplified → Taiwan Traditional (with phrases), anything → Simplified
_OPENCC = {"traditional": "s2twp", "simplified": "t2s"}
# A decoder prompt written in the requested script (used only when OpenCC is missing)
PROMPTS: dict[str, str] = {
    "traditional": "以下是繁體中文的字幕。",
    "simplified": "以下是简体中文的字幕。",
}


def requested_script(value: object) -> Script | None:
    """The script the caller asked for; anything else means keep what the model wrote."""
    if value == "traditional":
        return "traditional"
    if value == "simplified":
        return "simplified"
    return None


def is_chinese(language: str | None) -> bool:
    """Whisper reports Mandarin and Cantonese as ``zh`` and ``yue``."""
    return language in {"zh", "yue"}


def converter(script: Script) -> Callable[[str], str] | None:
    """A deterministic converter for the script, or None when the runtime has no OpenCC."""
    if find_spec("opencc") is None:
        return None
    module: Any = import_module("opencc")
    engine = module.OpenCC(_OPENCC[script])
    return engine.convert


def convert_cues(cues: list[Any], convert: Callable[[str], str]) -> None:
    """Convert every cue's text and its word texts in place (times and probabilities are unchanged)."""
    for cue in cues:
        cue["text"] = convert(cue["text"])
        for word in cue.get("words", ()):
            word["text"] = convert(word["text"])


def steering_prompt(
    script: Script | None,
    convert: Callable[[str], str] | None,
    language: str | None,
    detect: Callable[[], str],
) -> str | None:
    """The decoder prompt when there is no deterministic converter, for Chinese audio only.

    A Chinese prompt would disturb any other language, so an unspecified language is detected first.
    """
    if script is None or convert is not None:
        return None
    spoken = language if language is not None else detect()
    return PROMPTS[script] if is_chinese(spoken) else None


def apply_script(
    cues: list[Any],
    convert: Callable[[str], str] | None,
    prompt: str | None,
    language: str | None,
) -> Conversion:
    """Convert Chinese cues when a converter exists, and say how the script was applied."""
    if convert is not None and is_chinese(language):
        convert_cues(cues, convert)
        return "opencc"
    return "prompt" if prompt is not None else "none"
