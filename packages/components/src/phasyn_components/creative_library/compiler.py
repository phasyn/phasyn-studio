"""Compile a project shot with ordered, pinned entries; all creative prose is literal data."""

from __future__ import annotations

import re
from typing import Any

from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id
from phasyn_components.typed import check_fileref, check_typed_value

from .schema import MEDIA_KINDS


Doc = dict[str, Any]
MENTION = re.compile(r"@(Image|Audio|Video)([1-9][0-9]*)(?![A-Za-z0-9_])")
_MAX_REFERENCES = 9
_MAX_PROMPT_CHARS = 16_384
_MAX_REFERENCE_INDEX_DIGITS = 2
NATIVE = re.compile(r"<(Picture|Audio|Video) ([1-9][0-9]*)>")


def invalid(message: str, **details: Any) -> ComponentError:
    """Build a structured error for an invalid creative binding."""
    return ComponentError("INVALID_ARGUMENT", message, details=details)


def pick_image(project: Doc, item_id: str) -> Doc:
    """Resolve exactly one image from the current project library."""
    return _pick_media(project, item_id, "image")


def _pick_media(project: Doc, item_id: str, kind: str) -> Doc:
    item_id = require_local_id(item_id, "item_id")
    matches = [
        item for item in project.get("library", []) if item["item_id"] == item_id
    ]
    if len(matches) != 1:
        raise invalid("素材必須唯一屬於目前專案", item_id=item_id)
    item = matches[0]
    if item["kind"] != kind or not item["file"]["media_type"].startswith(f"{kind}/"):
        raise invalid(
            "素材類型與鏡頭輸入不符",
            item_id=item_id,
            expected=kind,
            actual=item["kind"],
        )
    return {
        "item_id": item_id,
        "name": item["name"],
        "file": check_fileref(item["file"], where="創作素材"),
    }


def find_shot(project: Doc, medium: str, shot_id: str) -> Doc:
    """Find a unique shot in the requested project collection."""
    collection, key = (
        ("shots", "shot_id") if medium == "video" else ("image_shots", "image_shot_id")
    )
    if medium not in ("video", "image"):
        raise invalid("鏡頭類型必須為 video 或 image")
    matches: list[Doc] = [
        shot for shot in project.get(collection, []) if shot[key] == shot_id
    ]
    if len(matches) != 1:
        raise ComponentError(
            "NOT_FOUND", "此專案找不到唯一對應的鏡頭", details={"shot_id": shot_id}
        )
    return matches[0]


def shot_inputs(shot: Doc, *, include_prompt: bool = True) -> Doc:
    """Select the shot fields which affect its compiled binding."""
    keys = (
        "prompt",
        "negative_prompt",
        "mode",
        "references",
        "continuity",
        "base_index",
        "mask_item_id",
        "mask_invert",
        "reference_resolution",
        "guidance",
    )
    return {
        key: shot[key]
        for key in keys
        if key in shot and (include_prompt or key not in {"prompt", "negative_prompt"})
    }


def _existing(project: Doc, shot: Doc, *, h3: bool) -> tuple[list[Doc], dict[str, str]]:
    refs = list(shot.get("references") or [])
    aliases: dict[str, str] = {}
    if h3:
        if (shot.get("continuity") or {}).get("mode", "none") != "none":
            raise invalid(
                "此鏡頭已設定首幀或接續上鏡，無法使用創作設定的文字或多參考路線"
            )
        for ref in refs:
            if ref["kind"] != "image" or not re.fullmatch(
                r"Image[1-9][0-9]{0,2}", ref["alias"]
            ):
                raise invalid(
                    "此編譯器支援 H3 圖片參考，無法編譯此鏡頭的參考類型或別名",
                    alias=ref["alias"],
                )
        refs.sort(key=lambda ref: int(ref["alias"][5:]))
        for i, ref in enumerate(refs, 1):
            if ref["alias"] in aliases:
                raise invalid("同一鏡頭有重複的圖片參考別名", alias=ref["alias"])
            aliases[ref["alias"]] = f"<Picture {i}>"
    else:
        refs.sort(key=lambda ref: ref["order"])
        if len({r["order"] for r in refs}) != len(refs):
            raise invalid("鏡頭包含相同順序的參考圖")
    return [
        dict(pick_image(project, ref["item_id"]), source="shot") for ref in refs
    ], aliases


def compile_binding(
    project: Doc, medium: str, shot_id: str, body: Doc, entries: list[Doc]
) -> Doc:
    """Compile literal prose and typed model inputs for a frozen shot binding."""
    model = body["model"]
    if body.get("include_prompt") is False and not body.get("media_bindings"):
        raise invalid("略過鏡頭提示詞前請選擇驅動素材")
    if body.get("media_bindings") and (model != "portable.video" or medium != "video"):
        raise invalid("驅動素材只能綁定到跨模型影片鏡頭")
    if model.startswith("portable."):
        return _portable_binding(project, medium, shot_id, body, entries)
    return _native_binding(project, medium, shot_id, body, entries)


def _native_binding(
    project: Doc, medium: str, shot_id: str, body: Doc, entries: list[Doc]
) -> Doc:
    model = body["model"]
    h3 = model.startswith("h3.")
    if h3 != (medium == "video"):
        raise invalid("模型與鏡頭類型不相容", model=model, medium=medium)
    shot = find_shot(project, medium, shot_id)
    if not h3 and shot["mode"] != model.split(".")[1]:
        raise invalid("模型路線與圖片鏡頭模式不同", model=model, mode=shot["mode"])
    refs, aliases = _existing(project, shot, h3=h3)
    fragments = _prompt_fragments(shot, body, entries, refs, aliases)
    reference_mode = model in {"h3.ref2va", "qimg.i2i"}
    if reference_mode != bool(refs) or len(refs) > (9 if h3 else 4):
        raise invalid(
            "模型路線與實際參考圖數量不相容", model=model, references=len(refs)
        )
    compiled = "\n".join(fragment["text"] for fragment in fragments)
    if not compiled.strip() or len(compiled) > _MAX_PROMPT_CHARS:
        raise invalid("編譯後 prompt 必須含文字且不超過 16384 字元")
    if h3 and any(
        kind != "Picture" or len(n) > _MAX_REFERENCE_INDEX_DIGITS or int(n) > len(refs)
        for kind, n in NATIVE.findall(compiled)
    ):
        raise invalid("編譯後 prompt 的模型參考標記沒有對應素材")
    inputs: Doc = {"prompt": {"type_id": "text.prompt.v1", "value": compiled}}
    if refs:
        if h3:
            inputs["materials"] = {
                "type_id": "h3.materials.v1",
                "value": [
                    {"role": "reference_image", "file": ref["file"]} for ref in refs
                ],
            }
        else:
            inputs["references"] = {
                "type_id": "qimg.references.v1",
                "value": [
                    {"label": ref["name"][:200], "file": ref["file"]} for ref in refs
                ],
            }
    if not h3 and shot.get("guidance", 1) > 1:
        inputs["negative_prompt"] = {
            "type_id": "text.prompt.v1",
            "value": shot["negative_prompt"],
        }
    mask = (
        None
        if h3
        else _mask_input(project, shot, refs, inputs, reference_mode=reference_mode)
    )
    for port, value in inputs.items():
        check_typed_value(value, where=port)
    _locate_fragments(fragments)
    return {
        "model": model,
        "medium": medium,
        "shot_id": shot_id,
        "project_revision": project["revision"],
        "source_digest": digest(shot_inputs(shot)),
        "entries": body["entries"],
        "state": body.get("state") or {},
        "inputs": inputs,
        "references": refs,
        "fragments": fragments,
        "mask": mask,
        "reference_settings": {}
        if h3
        else {
            "base_index": shot["base_index"] if mask else None,
            "mask_invert": shot["mask_invert"] if mask else False,
            "reference_resolution": shot["reference_resolution"],
            "cfg": shot["guidance"] > 1,
        },
    }


def _portable_references(
    project: Doc, medium: str, shot: Doc, selected: Doc
) -> tuple[list[Doc], dict[str, str]]:
    aliases: dict[str, str] = {}
    if medium == "image":
        refs, _ = _existing(project, shot, h3=False)
        if shot.get("mask_item_id"):
            raise invalid("有遮罩的圖片請選擇可保留遮罩設定的專用路線")
    else:
        raw = []
        for ref in shot.get("references") or []:
            role = {"audio": "source_audio", "video": "performance_video"}.get(
                ref["kind"]
            )
            if role and ref["item_id"] == selected.get(role):
                aliases[ref["alias"]] = role.replace("_", " ")
            else:
                raw.append(ref)
        if any(
            r["kind"] != "image"
            or not re.fullmatch(r"Image[1-9][0-9]{0,2}", r["alias"])
            for r in raw
        ):
            raise invalid("此綁定支援圖片參考，鏡頭包含其他參考類型")
        raw.sort(key=lambda r: int(r["alias"][5:]))
        if len({r["alias"] for r in raw}) != len(raw):
            raise invalid("同一鏡頭有重複的圖片參考別名")
        refs = []
        for ref in raw:
            refs.append(dict(pick_image(project, ref["item_id"]), source="shot"))
            aliases[ref["alias"]] = _image_label(refs, selected.get("character_image"))
    return refs, aliases


def _image_label(refs: list[Doc], character_id: str | None) -> str:
    if refs[-1]["item_id"] == character_id:
        return "Character"
    return f"Image {sum(ref['item_id'] != character_id for ref in refs)}"


def _portable_binding(
    project: Doc, medium: str, shot_id: str, body: Doc, entries: list[Doc]
) -> Doc:
    """Freeze creative intent independently of the native port names of a renderer."""
    if body["model"] != f"portable.{medium}":
        raise invalid("模型與鏡頭類型不相容", model=body["model"], medium=medium)
    shot = find_shot(project, medium, shot_id)
    selected = body.get("media_bindings") or {}
    include_prompt = body.get("include_prompt", True)
    refs, aliases = _portable_references(project, medium, shot, selected)
    fragments = _prompt_fragments(shot, body, entries, refs, aliases)
    prompt = "\n".join(f["text"] for f in fragments)
    if (
        len(refs) > _MAX_REFERENCES
        or (include_prompt and not prompt.strip())
        or len(prompt) > _MAX_PROMPT_CHARS
    ):
        raise invalid("創作綁定的參考數量或提示長度超出範圍")
    inputs: Doc = (
        {"prompt": {"type_id": "text.prompt.v1", "value": prompt}}
        if include_prompt
        else {}
    )
    for role, item_id in selected.items():
        kind = MEDIA_KINDS[role]
        item = _pick_media(project, item_id, kind)
        inputs[role] = {"type_id": f"media.{kind}.v1", "file": item["file"]}
    if (
        medium == "image"
        and shot.get("negative_prompt")
        and shot.get("guidance", 1) > 1
    ):
        inputs["negative_prompt"] = {
            "type_id": "text.prompt.v1",
            "value": shot["negative_prompt"],
        }
    other_refs = [
        ref for ref in refs if ref["item_id"] != selected.get("character_image")
    ]
    for number, ref in enumerate(other_refs, 1):
        inputs[f"reference_{number}"] = {
            "type_id": "media.image.v1",
            "file": ref["file"],
        }
    continuity = shot.get("continuity") or {}
    if continuity.get("mode", "none") != "none":
        first = continuity.get("first_frame")
        if not first:
            raise invalid("請先擷取接續影格再綁定此鏡頭")
        inputs["first_frame"] = {"type_id": "media.image.v1", "file": first}
    for role, value in inputs.items():
        check_typed_value(value, where=role)
    _locate_fragments(fragments)
    return {
        "model": body["model"],
        **({"media_bindings": dict(selected)} if selected else {}),
        **({"include_prompt": False} if not include_prompt else {}),
        "medium": medium,
        "shot_id": shot_id,
        "project_revision": project["revision"],
        "source_digest": digest(shot_inputs(shot, include_prompt=include_prompt)),
        "entries": body["entries"],
        "state": body.get("state") or {},
        "inputs": inputs,
        "references": refs,
        "fragments": fragments,
        "mask": None,
        "reference_settings": {},
    }


def _locate_fragments(fragments: list[Doc]) -> None:
    position = 0
    for fragment in fragments:
        fragment["start"] = position
        position += len(fragment["text"])
        fragment["end"] = position
        position += 1


def _mask_input(
    project: Doc, shot: Doc, refs: list[Doc], inputs: Doc, *, reference_mode: bool
) -> Doc | None:
    mask = None
    if shot.get("mask_item_id"):
        if (
            not reference_mode
            or shot.get("base_index") is None
            or not 0 <= shot["base_index"] < len(refs)
        ):
            raise invalid("Qwen 遮罩需要有效的參考圖與 base_index")
        mask = pick_image(project, shot["mask_item_id"])
        inputs["mask"] = {"type_id": "media.image.v1", "file": mask["file"]}
    return mask


def _prompt_fragments(
    shot: Doc, body: Doc, entries: list[Doc], refs: list[Doc], aliases: dict[str, str]
) -> list[Doc]:
    h3 = body["model"].startswith("h3.")
    fragments: list[Doc] = []

    def phrase(text: str, source: str, **origin: Any) -> None:
        if text:
            fragments.append({"text": text, "source": source, **origin})

    def mention(match: re.Match[str]) -> str:
        alias = match.group(0)[1:]
        if alias not in aliases:
            raise invalid("鏡頭 prompt 使用未綁定的參考別名", alias=alias)
        return aliases[alias]

    prompt = shot["prompt"]
    phrase(
        MENTION.sub(mention, prompt)
        if (h3 or body["model"] == "portable.video")
        and body.get("include_prompt", True)
        else prompt,
        "shot",
        field="prompt",
        original=prompt,
    )
    for selection, entry in zip(body["entries"], entries, strict=True):
        origin = {"entry_id": entry["entry_id"], "revision": entry["revision"]}
        overrides = selection.get("overrides") or {}
        for field, value in sorted((entry["fields"] | overrides).items()):
            phrase(
                f"{entry['name']} / {field}: {value}",
                "override" if field in overrides else "entry",
                field=field,
                **origin,
            )
        for ref in entry["references"]:
            refs.append({**ref, "source": "entry", **origin})
            label = (
                f"<Picture {len(refs)}>"
                if h3
                else _image_label(
                    refs, (body.get("media_bindings") or {}).get("character_image")
                )
            )
            phrase(
                f"{entry['name']}: {label}",
                "reference",
                item_id=ref["item_id"],
                **origin,
            )
    for field, value in sorted((body.get("state") or {}).items()):
        phrase(f"{field}: {value}", "shot_state", field=field)
    return fragments
