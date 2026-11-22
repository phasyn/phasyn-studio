"""Turn a local screenplay into a version-one editable Studio storyboard."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from ..errors import ComponentError


MAX_SCRIPT_CHARS = 32_768
MAX_BOARD_SHOTS = 48
MAX_PROMPT_CHARS = 4_000
MAX_CUE_CHARS = 60
SCENE_HEAD = re.compile(
    r"^(?:\.?((?:INT\.?/?EXT|EXT\.?/?INT|INT|EXT|I/E)\.(?:\s|$))"
    r"|(?:scene|場次|場景|场次|场景)\s*(?:[〇零一二三四五六七八九十百#\d：:]|$)"
    r"|第[〇零一二三四五六七八九十百\d]+[場场]|(?:內景|内景|外景)[\s：:\uFF0E.])",
    re.IGNORECASE,
)
SHOT_HEAD = re.compile(
    r"^(?:shot\s+(?:\#?\d+[A-Za-z]?|[:：])|"
    r"(?:鏡頭|镜头|分鏡|分镜)\s*(?:\#?\d+|[:：])|"
    r"第[〇零一二三四五六七八九十百\d]+[鏡镜])(?:[.\uFF0E\s:：-]*(.*))?$",
    re.IGNORECASE,
)
INLINE_CUE = re.compile(
    r"^([\w][\w .·'\u2019()（）-]{0,59})[：:]\s*(.+)$",
    re.UNICODE,
)
UNNAMED_LABELS = {
    "action",
    "description",
    "narration",
    "stage direction",
    "動作",
    "动作",
    "描述",
    "畫面",
    "画面",
}
UNNAMED_SPEECH = {"台詞", "台词", "对白", "對白", "旁白", "dialogue", "voiceover"}
# The storyboard importer reserves @aliases and treats these English directions as errors.
# Preserve such lines verbatim in source/segments and mark the draft prompt for a human edit.
STAGING_CONFLICT = re.compile(
    r"@[A-Za-z]|\b(?:no|not|never|without|nobody|nothing|"
    r"look(?:s|ing)?\s+(?:at|into|toward)|gaz(?:e|es|ing)|star(?:e|es|ing)|eye contact|eyes on)\b",
    re.IGNORECASE,
)


@dataclass
class DraftShot:
    """Source lines and an optional explicit shot heading."""

    line: int
    heading: str = ""
    title: str = ""
    rows: list[tuple[int, str]] = field(default_factory=list)


@dataclass
class Scene:
    """One explicit scene or the untitled leading section."""

    line: int
    heading: str
    shots: list[DraftShot] = field(default_factory=list)


def _scenes(script: str) -> Iterator[Scene]:
    scene: Scene | None = None
    shot: DraftShot | None = None
    for line, raw in enumerate(script.splitlines(), 1):
        text = raw.strip()
        heading_text = text.lstrip("#").strip().removeprefix("【").removesuffix("】")
        if SCENE_HEAD.match(heading_text):
            if scene is not None:
                yield scene
            scene, shot = Scene(line, text), None
            continue
        if not text:
            if shot is not None and shot.heading:
                shot.rows.append((line, raw))
            else:
                shot = None
            continue
        if scene is None:
            scene = Scene(line, "")
        if heading := SHOT_HEAD.fullmatch(heading_text):
            shot = DraftShot(line, text, (heading.group(1) or "").strip())
            scene.shots.append(shot)
        else:
            if shot is None:
                shot = DraftShot(line)
                scene.shots.append(shot)
            shot.rows.append((line, raw))
    if scene is not None:
        yield scene


def _speaker(text: str, following: str) -> str | None:
    """Recognize standalone Fountain character cues, including forced mixed-case names."""
    if len(text) > MAX_CUE_CHARS:
        return None
    if text.startswith("@") and re.fullmatch(r"[\w .·'\u2019()（）-]+", text[1:]):
        return text[1:].strip() or None
    if following.startswith(("「", "『", "“", '"')) and re.fullmatch(
        r"[\u3400-\u9fff·]{1,12}", text
    ):
        return text
    if text.isupper() and re.fullmatch(r"[\w .·'\u2019()（）-]+", text):
        return text
    return None


def _segments(shot: DraftShot) -> list[dict[str, Any]]:
    result = []
    speaker = None
    for index, (line, raw) in enumerate(shot.rows):
        text = raw.strip()
        if not text:
            speaker = None
            continue
        entry: dict[str, Any] = {"line": line, "text": raw}
        following = (
            shot.rows[index + 1][1].strip() if index + 1 < len(shot.rows) else ""
        )
        inline = INLINE_CUE.fullmatch(text)
        if inline and not inline[1].isdecimal() and not inline[2].startswith("//"):
            label, content = inline[1].strip(), inline[2].strip()
            narrative = label.casefold() in UNNAMED_LABELS
            name = None if narrative or label.casefold() in UNNAMED_SPEECH else label
            entry.update(
                kind="action" if narrative else "dialogue",
                speaker=name,
                content=content,
            )
            speaker = None
        elif following and (cue := _speaker(text, following)):
            speaker = cue
            entry.update(kind="cue", speaker=cue, content=text)
        else:
            is_speech = speaker is not None or text.startswith(("「", "『", "“", '"'))
            entry.update(
                kind="dialogue" if is_speech else "action",
                speaker=speaker,
                content=text,
            )
        result.append(entry)
    return result


def _prompt(parts: list[str], fallback: str) -> tuple[str, bool]:
    text = "\n".join(dict.fromkeys(part for part in parts if part))
    needs_edit = len(text) > MAX_PROMPT_CHARS or bool(STAGING_CONFLICT.search(text))
    if not needs_edit:
        return text or fallback, False
    safe_parts = [part for part in parts if part and not STAGING_CONFLICT.search(part)]
    safe = "\n".join(dict.fromkeys(safe_parts))
    return (safe if safe and len(safe) <= MAX_PROMPT_CHARS else fallback), True


def _shot_doc(scene: Scene, shot: DraftShot, sid: str, cut_s: float) -> dict[str, Any]:
    lines = _segments(shot)
    dialogue = [entry for entry in lines if entry["kind"] == "dialogue"]
    actions = [str(entry["content"]) for entry in lines if entry["kind"] == "action"]
    names = list(
        dict.fromkeys(str(entry["speaker"]) for entry in dialogue if entry["speaker"])
    )
    figure = "、".join(names) or "說話者"
    pose = f"{figure}在畫面中說話。" if dialogue else ""
    context = [scene.heading, shot.title]
    keyframe, edit_frame = _prompt([*context, *actions, pose], "以固定鏡位交代場景。")
    action, edit_action = _prompt(
        [*actions, pose] if actions or pose else context, "固定鏡位保留本段構圖。"
    )
    return {
        "id": sid,
        "role": "dialogue"
        if dialogue
        else "establish"
        if not scene.shots or shot is scene.shots[0]
        else "action",
        "size": "medium" if dialogue else "wide",
        "angle": "eye level",
        "camera": "locked",
        "cut_s": cut_s,
        "refs": [],
        "keyframe": keyframe,
        "action": action,
        "script": {
            "line": shot.line,
            "heading": shot.heading,
            "segments": lines,
            "needs_prompt_edit": edit_frame or edit_action,
        },
    }


def compile_board(script: str, *, board_id: str | None, cut_s: float) -> dict[str, Any]:
    """Construct an importable board; keep exact source text alongside editable visual fields."""
    if not script.strip() or len(script) > MAX_SCRIPT_CHARS:
        raise ComponentError(
            "INVALID_ARGUMENT", f"劇本需包含文字，總長上限 {MAX_SCRIPT_CHARS} 字元"
        )
    try:
        digest = hashlib.sha256(script.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        raise ComponentError(
            "INVALID_ARGUMENT", "劇本包含無法轉成 UTF-8 的字元"
        ) from None
    prefix = board_id or f"b{digest[:12]}"
    scenes: list[dict[str, Any]] = []
    shots: list[dict[str, Any]] = []
    cast: dict[str, None] = {}
    for index, scene in enumerate(_scenes(script), 1):
        scene_id = f"{prefix}-s{index:02}"
        ids = []
        for number, shot in enumerate(scene.shots or [DraftShot(scene.line)], 1):
            if len(shots) >= MAX_BOARD_SHOTS:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"分鏡超出 {MAX_BOARD_SHOTS} 鏡；請依場次拆開劇本",
                )
            sid = f"{scene_id}-{number:02}"
            draft = _shot_doc(scene, shot, sid, cut_s)
            draft["script"]["scene_id"] = scene_id
            for entry in draft["script"]["segments"]:
                if entry["speaker"]:
                    cast[entry["speaker"]] = None
            ids.append(sid)
            shots.append(draft)
        scenes.append(
            {"id": scene_id, "line": scene.line, "heading": scene.heading, "shots": ids}
        )
    return {
        "version": 1,
        "library": {},
        "keyframe": {},
        "video": {},
        "shots": shots,
        "scenes": scenes,
        "characters": list(cast),
        "source": {"text": script, "sha256": digest, "line_numbers": "one_based"},
    }
