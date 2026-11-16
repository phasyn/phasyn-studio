"""Named timeline commands: the wire form of the edits (``POST …/timeline/commands``).

A command is a JSON object selected by ``op`` (contract ``StudioTimelineCommand``). :func:`apply_command` applies
one to a project and returns the new project or raises :class:`TimelineRejected`; :func:`apply_commands` is the
transaction the Controller runs: normalize, apply every command in order, normalize, and either a fully valid
project or an error that names the refused command. Nothing here touches a file or a clock: new ids come from
the allocator the caller passes in.
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .. import contracts
from ..errors import ComponentError
from ..timeline_limits import MAX_COMMANDS, MAX_SEQUENCE_FRAMES
from . import arrange, edits
from .adjustment import add_adjustment_layer
from .binding import apply_pending, pending_sources
from .core import next_clip, previous_clip, required_clip, unlocked
from .model import (
    TRANSITION_DIRECTIONS,
    AllocateId,
    Doc,
    clip_duration,
    clip_end,
    default_motion,
    empty_timeline,
    find_source,
    find_track,
    first_track,
    tracks_end,
    used_ids,
)
from .normalize import normalize_project, place_shots, representable, shown_shot_ids
from .rejection import TimelineRejected, reject
from .shots import bound_take, library_source, rate, shot_source, unique_id
from .text import CAPTION_SECONDS, STYLE_FIELDS, add_text_layer, default_title_style, parse_srt, seconds_to_frames
from .text import round_half_up as _round

COMMAND_DEFS: Mapping[str, str] = {
    "assemble": "TimelineCommandAssemble",
    "place": "TimelineCommandPlace",
    "move": "TimelineCommandMove",
    "trim": "TimelineCommandTrim",
    "slip": "TimelineCommandSlip",
    "slide": "TimelineCommandSlide",
    "split": "TimelineCommandSplit",
    "remove": "TimelineCommandRemove",
    "set_clip": "TimelineCommandSetClip",
    "transition": "TimelineCommandTransition",
    "add_text": "TimelineCommandAddText",
    "add_adjustment": "TimelineCommandAddAdjustment",
    "track": "TimelineCommandTrack",
    "marker": "TimelineCommandMarker",
    "caption": "TimelineCommandCaption",
    "work_area": "TimelineCommandWorkArea",
    "master": "TimelineCommandMaster",
    "join": "TimelineCommandJoin",
    "rearrange": "TimelineCommandRearrange",
    "reconcile": "TimelineCommandReconcile",
    "set_enabled": "TimelineCommandSetEnabled",
}
TRANSITION_KINDS = {"fade_black": "dip_to_black", "fade_white": "dip_to_white"}
# The names of a transition's alignment on its cut, as the editor's Effect Controls show them.
ALIGNMENT_NAMES = {"center": "置中於切點", "start": "從切點開始", "end": "在切點結束"}
# What a moving transition can be told besides its kind and length; what is left out keeps the current value.
TRANSITION_OPTIONS = ("direction", "easing", "softness")
DEFAULT_TRANSITION_FRAMES = 12
IMAGE_SECONDS = 5
TRACK_FIELDS = ("name", "locked", "muted", "solo", "sync_lock", "gain_db", "pan")
CAPTION_FIELDS = ("text", "start_frame", "end_frame", "position", "size")
MARKER_FIELDS = ("frame", "name", "color")
CLIP_FIELDS = ("name", "effects", "motion", "blend_mode", "mask", "effect_stack")
NULLABLE_TITLE_FIELDS = ("end_frame", "image", "image_key")
NEW_TITLE: Mapping[str, Any] = {
    "position": "bottom",
    "size": "medium",
    "start_frame": 0,
    "end_frame": None,
    "image": None,
}
TRACK_NAMES = {"video": "V", "audio": "A"}


@dataclass
class Applied:
    """What one command did (contract ``StudioTimelineApplied``)."""

    op: str
    summary: str
    clip_ids: list[str] = field(default_factory=list)
    track_ids: list[str] = field(default_factory=list)
    marker_ids: list[str] = field(default_factory=list)
    caption_ids: list[str] = field(default_factory=list)
    source_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> Doc:
        value: Doc = {"op": self.op, "clip_ids": list(dict.fromkeys(self.clip_ids)), "summary": self.summary}
        for name in ("track_ids", "marker_ids", "caption_ids", "source_ids"):
            if getattr(self, name):
                value[name] = list(dict.fromkeys(getattr(self, name)))
        return value


@dataclass
class _Context:
    project: Doc
    allocate: AllocateId

    @property
    def timeline(self) -> Doc:
        timeline = self.project.get("timeline")
        if timeline is None:
            fps = self.project["format"]["fps"]
            if not representable(fps):
                reject("fps", "剪輯影格率必須介於 1–240 fps")
            timeline = empty_timeline(fps)
            self.project["timeline"] = timeline
        return dict(timeline)

    def edit(self, change: edits.Edit, *, reconcile: bool = False) -> Doc:
        """Run one edit of the timeline as a transaction and keep its result."""
        self.project["timeline"] = edits.run_edit(self.timeline, change, reconcile=reconcile)
        return dict(self.project["timeline"])

    def export_size(self) -> tuple[int, int]:
        frame = self.project.get("export_format") or self.project["format"]
        return int(frame["width"]), int(frame["height"])


Handler = Callable[[_Context, Mapping[str, Any]], Applied]


def check_command(command: Any) -> str:
    """The ``op`` of a well-formed command; a typed rejection (``invalid_command``) otherwise."""
    op = command.get("op") if isinstance(command, Mapping) else None
    name = COMMAND_DEFS.get(op) if isinstance(op, str) else None
    if name is None:
        reject("invalid_command", "不支援的時間軸指令；op 必須是契約列出的指令名稱", supported=sorted(COMMAND_DEFS))
    problems = contracts.errors(name, command, limit=5)
    if problems:
        reject("invalid_command", f"時間軸指令 {op} 不符合契約：{problems[0]}", errors=problems)
    return str(op)


def _one_of(command: Mapping[str, Any], names: Sequence[str]) -> str:
    """The single one of ``names`` the command carries."""
    given = [name for name in names if name in command]
    if len(given) != 1:
        reject("invalid_command", f"必須指定 {'、'.join(names)} 其中一個", fields=list(names))
    return given[0]


def _flat(command: Mapping[str, Any], names: Sequence[str]) -> Doc:
    """The named fields of a command; the flat form wins over the nested ``fields`` object."""
    nested = command.get("fields") or {}
    return {name: command.get(name, nested.get(name)) for name in names if name in command or name in nested}


def _linked(command: Mapping[str, Any]) -> bool:
    return command.get("linked", True) is not False


def _list_shots(timeline: Doc, shot_ids: Sequence[str]) -> None:
    listed = list(timeline.get("placed_shot_ids") or [])
    timeline["placed_shot_ids"] = [*listed, *(shot_id for shot_id in dict.fromkeys(shot_ids) if shot_id not in listed)]


def _assemble(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    shots = ctx.project.get("shots") or []
    rebuild = command["mode"] == "rebuild"
    if rebuild and command.get("confirm") is not True:
        reject("confirm_required", "重建會清除第一條影像軌與第一條音軌上的所有片段；確認後請加上 confirm: true")
    placed: list[str] = []
    created: list[str] = []

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        shown = shown_shot_ids(draft)
        if rebuild:
            cleared = [track for track in (first_track(draft, "video"), first_track(draft, "audio")) if track]
            for track in cleared:
                unlocked(draft, track["track_id"])
            ids = {track["track_id"] for track in cleared}
            draft["clips"] = [clip for clip in draft["clips"] if clip["track_id"] not in ids]
        wanted = [shot for shot in shots if (shot["shot_id"] in shown) == rebuild]
        before = {clip["clip_id"] for clip in draft["clips"]}
        placed.extend(place_shots(ctx.project, draft, wanted, []))
        _list_shots(draft, placed)
        created.extend(clip["clip_id"] for clip in draft["clips"] if clip["clip_id"] not in before)

    ctx.edit(change)
    if rebuild:
        summary = f"已重建第一條影像軌與音軌：依鏡頭順序排入 {len(placed)} 個鏡頭"
    else:
        summary = f"已把 {len(placed)} 個尚未放入的鏡頭接到時間軸結尾" if placed else "沒有需要放入時間軸的鏡頭"
    return Applied("assemble", summary, clip_ids=created)


def _media_source(ctx: _Context, draft: Doc, command: Mapping[str, Any]) -> Doc:
    """The source a ``place`` names, added to the draft when the timeline does not have it yet."""
    key = _one_of(command, ("shot_id", "library_id", "source_id"))
    wanted = command[key]
    if key == "source_id":
        found = find_source(draft, wanted)
        if found is None:
            reject("source_not_found", "找不到指定的素材", source_id=wanted)
        return found
    known = [source for source in draft["sources"] if source.get(key) == wanted]
    created: Doc | None
    if key == "shot_id":
        shot = next((item for item in ctx.project.get("shots") or [] if item["shot_id"] == wanted), None)
        if shot is None:
            reject("shot_not_found", "找不到指定的鏡頭", shot_id=wanted)
        take = bound_take(shot)
        # A shot can have a source per take it was ever bound to; the one showing its take in use comes first.
        known.sort(key=lambda source: take is None or source.get("take_id") != take["take_id"])
        created = shot_source(ctx.project, shot, draft["fps"])
    else:
        item = next((entry for entry in ctx.project.get("library") or [] if entry["item_id"] == wanted), None)
        if item is None:
            reject("library_item_not_found", "找不到指定的素材庫項目", library_id=wanted)
        created = library_source(item, draft["fps"])
    if known:
        return known[0]
    if created is None:
        reject("source_unavailable", "這個素材的長度未知，無法放入時間軸；請先確認它可以播放", library_id=wanted)
    created["source_id"] = unique_id(created["source_id"], used_ids(draft))
    draft["sources"].append(created)
    return created


def _place_tracks(draft: Mapping[str, Any], source: Mapping[str, Any], command: Mapping[str, Any]) -> list[str]:
    """The tracks a ``place`` puts clips on: video first, then audio."""
    has_audio = source["kind"] == "audio" or bool(source["has_audio"])
    video = command.get("video", source["kind"] != "audio")
    audio = command.get("audio", has_audio)
    if video and source["kind"] == "audio":
        reject("track_kind", "純音訊素材不能放入影像軌")
    if audio and not has_audio:
        reject("track_kind", "素材沒有音訊，不能放入音軌")
    tracks: list[str] = []
    for kind, wanted, key in (("video", video, "track_video"), ("audio", audio, "track_audio")):
        if not wanted:
            continue
        track = find_track(draft, command[key]) if key in command else first_track(draft, kind)
        if track is None:
            reject("track_not_found", "找不到要放入的軌道；請先新增對應的影像軌或音軌", kind=kind)
        if track["kind"] != kind:
            reject("track_kind", "指定的軌道種類與要放入的內容不同", track_id=track["track_id"])
        tracks.append(str(track["track_id"]))
    if not tracks:
        reject("invalid_command", "請至少放入影像或聲音其中一種")
    return tracks


def _place_range(draft: Mapping[str, Any], source: Mapping[str, Any], command: Mapping[str, Any]) -> tuple[int, int]:
    length = int(source["duration_frames"])
    first = int(command.get("in_frame", 0))
    if "out_frame" in command:
        out = int(command["out_frame"])
    elif source["kind"] in ("image", "adjustment"):
        # A still and an adjustment layer have no length of their own: five seconds unless the command says
        out = min(length, first + max(1, _round(rate(draft["fps"]) * IMAGE_SECONDS)))
    else:
        out = length
    if not 0 <= first < out <= length:
        reject("source_range", "片段入出點超出原始素材範圍", duration_frames=length)
    return first, out


def _place(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    mode = command.get("mode", "overwrite")
    result: Doc = {}

    def change(draft: Doc, origins: dict[str, str]) -> None:
        source = _media_source(ctx, draft, command)
        tracks = _place_tracks(draft, source, command)
        first, out = _place_range(draft, source, command)
        at = command.get("at", "end")
        start = tracks_end(draft, tracks) if at == "end" else int(at)
        link = ctx.allocate("link")
        clips = [
            {
                "clip_id": ctx.allocate("clip"),
                "source_id": source["source_id"],
                "track_id": track_id,
                "name": source["name"],
                "start_frame": 0,
                "in_frame": first,
                "out_frame": out,
                "linked_id": link,
                "motion": default_motion(),
            }
            for track_id in tracks
        ]
        edits.place(draft, clips, start, out - first, mode, ctx.allocate, origins)
        if source.get("shot_id"):
            _list_shots(draft, [source["shot_id"]])
        result.update(ids=edits.clip_ids_of(clips), source=source, start=start, frames=out - first)

    ctx.edit(change, reconcile=mode == "overwrite")
    name = result["source"]["name"] or result["source"]["source_id"]
    summary = f"已放入「{name}」：第 {result['start']} 影格起 {result['frames']} 影格（{mode}）"
    return Applied("place", summary, clip_ids=result["ids"], source_ids=[result["source"]["source_id"]])


def _move(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    ids = list(command["clip_ids"])
    primary = required_clip(ctx.timeline, ids[0])
    if _one_of(command, ("to_frame", "delta")) == "to_frame":
        start = int(command["to_frame"])
    else:
        start = int(primary["start_frame"]) + int(command["delta"])
    if start < 0:
        reject("out_of_range", "片段不能移到序列起點之前")
    track_id = command.get("track_id", primary["track_id"])
    mode = command.get("mode", "overwrite")
    moved: list[str] = []
    ctx.edit(
        lambda draft, origins: moved.extend(
            edits.move(draft, ids, start, track_id, mode, _linked(command), ctx.allocate, origins)
        ),
        reconcile=True,
    )
    return Applied("move", f"已移動 {len(moved)} 個片段到第 {start} 影格（{mode}）", clip_ids=moved)


def _trim(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    clip = required_clip(ctx.timeline, command["clip_id"])
    edge, mode, linked = command["edge"], command.get("mode", "normal"), _linked(command)
    if _one_of(command, ("to_frame", "delta")) == "to_frame":
        delta = int(command["to_frame"]) - (int(clip["start_frame"]) if edge == "in" else clip_end(clip))
    else:
        delta = int(command["delta"])
    changed: list[str] = []
    if mode == "roll":
        neighbour = next_clip(ctx.timeline, clip) if edge == "out" else previous_clip(ctx.timeline, clip)
        if neighbour is None:
            reject("not_adjacent", "滾動編輯需要同軌且緊鄰的兩個片段")
        left, right = (clip, neighbour) if edge == "out" else (neighbour, clip)
        ctx.edit(
            lambda draft, _origins: changed.extend(edits.roll(draft, left["clip_id"], right["clip_id"], delta, linked)),
            reconcile=True,
        )
    else:
        ctx.edit(
            lambda draft, _origins: changed.extend(
                edits.trim(draft, clip["clip_id"], edge, delta, mode == "ripple", linked)
            ),
            reconcile=True,
        )
    return Applied("trim", f"已修剪「{clip['name']}」的 {edge} 點 {delta:+d} 影格（{mode}）", clip_ids=changed)


def _slip(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    changed: list[str] = []
    delta = int(command["delta"])
    ctx.edit(lambda draft, _origins: changed.extend(edits.slip(draft, command["clip_id"], delta, _linked(command))))
    return Applied("slip", f"已把片段內容外滑 {delta:+d} 影格", clip_ids=changed)


def _slide(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    changed: list[str] = []
    delta = int(command["delta"])
    ctx.edit(
        lambda draft, _origins: changed.extend(edits.slide(draft, command["clip_id"], delta, _linked(command))),
        reconcile=True,
    )
    return Applied("slide", f"已把片段內滑 {delta:+d} 影格", clip_ids=changed)


def _split(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    frame = int(command["at_frame"])
    timeline = ctx.timeline
    if "clip_ids" in command:
        ids = list(command["clip_ids"])
    else:
        open_tracks = {track["track_id"] for track in timeline["tracks"] if not track["locked"]}
        ids = [
            clip["clip_id"]
            for clip in timeline["clips"]
            if clip["track_id"] in open_tracks and clip["start_frame"] < frame < clip_end(clip)
        ]
        if not ids:
            reject("out_of_range", "這個影格下沒有可以分割的片段", frame=frame)
    created: list[str] = []
    ctx.edit(lambda draft, _origins: created.extend(edits.split(draft, ids, frame, _linked(command), ctx.allocate)))
    return Applied("split", f"已在第 {frame} 影格分割 {len(created)} 個片段", clip_ids=created)


def _remove(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    ripple = command.get("ripple", False) is True
    removed: list[str] = []
    ctx.edit(
        lambda draft, origins: removed.extend(
            edits.remove(draft, list(command["clip_ids"]), ripple, _linked(command), ctx.allocate, origins)
        ),
        reconcile=True,
    )
    summary = f"已刪除 {len(removed)} 個片段（ripple: {str(ripple).lower()}）"
    return Applied("remove", summary, clip_ids=removed)


def _merged_members(current: Any, patch: Mapping[str, Any], keep_null: Sequence[str] = ()) -> Doc:
    """``current`` (an object or nothing) with the members of ``patch``; a null removes its member."""
    merged: Doc = copy.deepcopy(dict(current)) if isinstance(current, Mapping) else {}
    for key, value in patch.items():
        if value is None and key not in keep_null:
            merged.pop(key, None)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _merged_effects(current: Mapping[str, Any] | None, patch: Mapping[str, Any] | None) -> Doc | None:
    """Clip effects after a partial update; member objects merge one level deep. None when nothing is left."""
    kept = {"transition_out": current["transition_out"]} if current and "transition_out" in current else {}
    if patch is None:
        return copy.deepcopy(kept) or None
    if "transition_out" in patch:
        reject("invalid_command", "轉場請使用 transition 指令設定")
    merged: Doc = copy.deepcopy(dict(current or {}))
    for key, value in patch.items():
        if value is None:
            merged.pop(key, None)
        elif key == "title" and isinstance(value, Mapping):
            base = merged.get("title") or NEW_TITLE
            merged["title"] = _merged_members(base, value, NULLABLE_TITLE_FIELDS)
        elif isinstance(value, Mapping):
            merged[key] = _merged_members(merged.get(key), value)
        else:
            merged[key] = copy.deepcopy(value)
    problems = contracts.errors("MediaClipEffects", merged, limit=5)
    if problems:
        reject("invalid_command", f"effects 不符合契約：{problems[0]}", errors=problems)
    return merged or None


def _merged_motion(current: Mapping[str, Any], patch: Mapping[str, Any]) -> Doc:
    merged: Doc = copy.deepcopy(dict(current))
    for key, value in patch.items():
        if key == "keyframes" and isinstance(value, Mapping):
            merged["keyframes"] = _merged_members(merged.get("keyframes"), value)
        elif value is not None:
            merged[key] = copy.deepcopy(value)
    problems = contracts.errors("TimelineMotion", merged, limit=5)
    if problems:
        reject("invalid_command", f"motion 不符合契約：{problems[0]}", errors=problems)
    return merged


def _set_clip(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    clip = required_clip(ctx.timeline, command["clip_id"])
    linked = _linked(command)
    patch: Doc = {}
    for name in CLIP_FIELDS:
        if name not in command:
            continue
        if name == "effects":
            patch[name] = _merged_effects(clip.get("effects"), command[name])
        elif name == "motion":
            patch[name] = _merged_motion(clip["motion"], command[name])
        else:
            patch[name] = command[name]
    if not patch and "enabled" not in command:
        reject("invalid_command", "沒有要變更的片段屬性")
    changed: list[str] = []

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        if patch:
            changed.extend(edits.patch_clip(draft, clip["clip_id"], patch, linked))
        if "enabled" in command:
            changed.extend(arrange.set_enabled(draft, [clip["clip_id"]], command["enabled"], linked))

    ctx.edit(change)
    fields = "、".join([*patch, *(["enabled"] if "enabled" in command else [])])
    return Applied("set_clip", f"已更新「{clip['name']}」的 {fields}", clip_ids=changed)


def _transition_options(kind: str, command: Mapping[str, Any]) -> Doc:
    """The direction, easing and softness a command sets; refused where the kind cannot have them."""
    options = {name: command[name] for name in TRANSITION_OPTIONS if name in command}
    directions = TRANSITION_DIRECTIONS.get(kind)
    if options and directions is None:
        reject("invalid_command", "只有 push、slide、whip、wipe、zoom 轉場有方向、緩動與柔邊", fields=sorted(options))
    if "direction" in options and directions is not None and options["direction"] not in directions:
        reject("invalid_command", "這個轉場不能朝這個方向；縮放是 in 或 out，其他是 left、right、up 或 down")
    if "softness" in options and kind != "wipe":
        reject("invalid_command", "只有擦除（wipe）轉場有柔邊", fields=["softness"])
    return options


def _transition(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    kind = TRANSITION_KINDS.get(command["kind"], command["kind"])
    frames = int(command.get("frames", DEFAULT_TRANSITION_FRAMES))
    options = _transition_options(kind, command)
    alignment = command.get("alignment")
    if kind == "cut" and alignment is not None:
        reject("invalid_command", "移除轉場（cut）沒有對齊方式", fields=["alignment"])
    changed: list[str] = []
    timeline = ctx.edit(
        lambda draft, _origins: changed.extend(
            edits.transition(draft, command["clip_id"], kind, frames, _linked(command), options, alignment)
        )
    )
    if kind == "cut":
        return Applied("transition", "已移除轉場（直接切換）", clip_ids=changed)
    # The edit records the cut on the clip it was given: where it sits, and the frames it repeats where media ran out
    cut = required_clip(timeline, command["clip_id"])["effects"]["transition_out"]["cut"]
    summary = f"已設定 {frames} 影格的 {kind} 轉場（{ALIGNMENT_NAMES[cut['alignment']]}）"
    repeated = int(cut["outgoing"]["freeze"]) + int(cut["incoming"]["freeze"])
    if repeated:
        summary += f"；素材不足，重複 {repeated} 影格"
    return Applied("transition", summary, clip_ids=changed)


def _add_text(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    position, size = command.get("position", "center"), command.get("size", "medium")
    style = {**default_title_style(position, size), **{name: command[name] for name in STYLE_FIELDS if name in command}}
    title = {"text": command["text"], "position": position, "size": size, "style": style}
    before = {track["track_id"] for track in ctx.timeline["tracks"]}
    created: list[str] = []
    at = int(command["at_frame"])

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        duration = command.get("duration_frames")
        created.append(
            add_text_layer(draft, title, at, duration, command.get("track_id"), ctx.export_size(), ctx.allocate)
        )

    timeline = ctx.edit(change)
    clip = required_clip(timeline, created[0])
    tracks = [track["track_id"] for track in timeline["tracks"] if track["track_id"] not in before]
    summary = f"已在第 {at} 影格加入文字圖層（{clip_duration(clip)} 影格）"
    return Applied("add_text", summary, clip_ids=created, track_ids=tracks, source_ids=[clip["source_id"]])


def _add_adjustment(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    before = {track["track_id"] for track in ctx.timeline["tracks"]}
    created: list[str] = []
    at = int(command["at_frame"])

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        duration, track_id, name = command.get("duration_frames"), command.get("track_id"), command.get("name")
        created.append(add_adjustment_layer(draft, at, duration, track_id, name, ctx.export_size(), ctx.allocate))

    timeline = ctx.edit(change)
    clip = required_clip(timeline, created[0])
    tracks = [track["track_id"] for track in timeline["tracks"] if track["track_id"] not in before]
    track = find_track(timeline, clip["track_id"]) or {}
    summary = f"已在第 {at} 影格加入調整圖層（{clip_duration(clip)} 影格，{track.get('name') or clip['track_id']}）"
    return Applied("add_adjustment", summary, clip_ids=created, track_ids=tracks, source_ids=[clip["source_id"]])


def _track_name(timeline: Mapping[str, Any], kind: str) -> str:
    names = {track["name"] for track in timeline["tracks"]}
    number = 1
    while f"{TRACK_NAMES[kind]}{number}" in names:
        number += 1
    return f"{TRACK_NAMES[kind]}{number}"


def _track(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    action = command["action"]
    fields = _flat(command, TRACK_FIELDS)
    if action == "add":
        if "kind" not in command:
            reject("invalid_command", "新增軌道需要 kind（video 或 audio）")
        created: list[str] = []

        def add(draft: Doc, _origins: dict[str, str]) -> None:
            name = fields.get("name") or _track_name(draft, command["kind"])
            track_id = edits.add_track(draft, command["kind"], name, ctx.allocate)
            edits.patch_track(draft, track_id, {key: value for key, value in fields.items() if key != "name"})
            created.append(track_id)

        ctx.edit(add)
        return Applied("track", "已新增軌道", track_ids=created)
    if "track_id" not in command:
        reject("invalid_command", "這個軌道動作需要 track_id")
    track_id = command["track_id"]
    if action == "remove":
        ctx.edit(lambda draft, _origins: edits.remove_track(draft, track_id))
        return Applied("track", "已移除軌道", track_ids=[track_id])
    if action == "rename":
        fields = {"name": fields["name"]} if "name" in fields else {}
    if not fields:
        reject("invalid_command", "沒有要變更的軌道欄位")
    ctx.edit(lambda draft, _origins: edits.patch_track(draft, track_id, fields))
    return Applied("track", f"已更新軌道的 {'、'.join(fields)}", track_ids=[track_id])


def _item(items: Sequence[Doc], key: str, wanted: str, reason: str, message: str) -> Doc:
    found = next((item for item in items if item[key] == wanted), None)
    if found is None:
        reject(reason, message, **{key: wanted})
    return found


def _marker(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    action = command["action"]
    fields = {name: command[name] for name in MARKER_FIELDS if name in command}
    if action == "add":
        if "frame" not in fields:
            reject("invalid_command", "新增標記需要 frame")
        marker = {
            "marker_id": ctx.allocate("marker"),
            "frame": fields["frame"],
            "name": fields.get("name", ""),
            "color": fields.get("color", "blue"),
        }
        ctx.edit(lambda draft, _origins: draft["markers"].append(marker))
        return Applied("marker", f"已在第 {marker['frame']} 影格新增標記", marker_ids=[marker["marker_id"]])
    if "marker_id" not in command:
        reject("invalid_command", "這個標記動作需要 marker_id")
    marker_id = command["marker_id"]

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        found = _item(draft["markers"], "marker_id", marker_id, "marker_not_found", "找不到指定的標記")
        if action == "remove":
            draft["markers"] = [item for item in draft["markers"] if item is not found]
        else:
            found.update(fields)

    if action == "update" and not fields:
        reject("invalid_command", "沒有要變更的標記欄位")
    ctx.edit(change)
    return Applied("marker", "已移除標記" if action == "remove" else "已更新標記", marker_ids=[marker_id])


def _new_caption(ctx: _Context, fields: Mapping[str, Any]) -> Doc:
    if "text" not in fields or "start_frame" not in fields:
        reject("invalid_command", "新增字幕需要 text 與 start_frame")
    start = int(fields["start_frame"])
    length = seconds_to_frames(CAPTION_SECONDS, ctx.timeline["fps"])
    return {
        "caption_id": ctx.allocate("caption"),
        "start_frame": start,
        "end_frame": int(fields.get("end_frame", min(MAX_SEQUENCE_FRAMES, start + length))),
        "text": fields["text"],
        "position": fields.get("position", "bottom"),
        "size": fields.get("size", "medium"),
    }


def _caption(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    action = command["action"]
    fields = _flat(command, CAPTION_FIELDS)
    if action == "clear":
        count = len(ctx.timeline["captions"])
        ctx.edit(lambda draft, _origins: draft["captions"].clear())
        return Applied("caption", f"已清除 {count} 段字幕")
    if action in ("add", "import_srt"):
        if action == "add":
            added = [_new_caption(ctx, fields)]
        else:
            if "srt" not in command:
                reject("invalid_command", "匯入字幕需要 srt 文字")
            parsed = parse_srt(command["srt"], ctx.timeline["fps"])
            added = [{"caption_id": ctx.allocate("caption"), **caption} for caption in parsed]
        ctx.edit(lambda draft, _origins: draft["captions"].extend(added))
        ids = [caption["caption_id"] for caption in added]
        return Applied("caption", f"已加入 {len(added)} 段字幕", caption_ids=ids)
    if "caption_id" not in command:
        reject("invalid_command", "這個字幕動作需要 caption_id")
    caption_id = command["caption_id"]
    if action == "update" and not fields:
        reject("invalid_command", "沒有要變更的字幕欄位")

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        found = _item(draft["captions"], "caption_id", caption_id, "caption_not_found", "找不到指定的字幕")
        if action == "remove":
            draft["captions"] = [item for item in draft["captions"] if item is not found]
        else:
            found.update(fields)

    ctx.edit(change)
    return Applied("caption", "已移除字幕" if action == "remove" else "已更新字幕", caption_ids=[caption_id])


def _work_area(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    if command.get("clear") is True:
        if "start_frame" in command or "end_frame" in command:
            reject("invalid_command", "clear 不能與 start_frame、end_frame 同時指定")
        ctx.edit(lambda draft, _origins: draft.pop("work_area", None))
        return Applied("work_area", "已清除序列入出點")
    if "start_frame" not in command or "end_frame" not in command:
        reject("invalid_command", "請指定 start_frame 與 end_frame，或以 clear: true 清除")
    area = {"start_frame": int(command["start_frame"]), "end_frame": int(command["end_frame"])}
    ctx.edit(lambda draft, _origins: draft.update(work_area=area))
    return Applied("work_area", f"已設定序列入出點：第 {area['start_frame']}–{area['end_frame']} 影格")


def _master(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    gain = command["gain_db"]
    ctx.edit(lambda draft, _origins: draft.update(master_gain_db=gain))
    return Applied("master", f"已把主音量設為 {gain} dB")


def _join(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    joined: list[str] = []
    ctx.edit(lambda draft, _origins: joined.extend(arrange.join(draft, command["clip_id"], _linked(command))))
    return Applied("join", f"已接合 {len(joined)} 個編輯點", clip_ids=joined)


def _rearrange(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    ids, frame, linked = list(command["clip_ids"]), int(command["to_frame"]), _linked(command)
    moved: list[str] = []

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        target, side = arrange.rearrange_target(draft, ids, frame, linked)
        moved.extend(arrange.rearrange(draft, ids, target, side, linked))

    ctx.edit(change)
    return Applied("rearrange", f"已把 {len(moved)} 個片段調整到第 {frame} 影格的編輯點", clip_ids=moved)


def _reconcile(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    key = _one_of(command, ("source_id", "shot_id"))
    result: Doc = {}

    def change(draft: Doc, _origins: dict[str, str]) -> None:
        sources = pending_sources(draft, command.get("source_id"), command.get("shot_id"))
        trimmed, removed = apply_pending(draft, ctx.project, sources)
        result.update(trimmed=trimmed, removed=removed, sources=[source["source_id"] for source in sources])

    if key == "shot_id" and not any(shot["shot_id"] == command[key] for shot in ctx.project.get("shots") or []):
        reject("shot_not_found", "找不到指定的鏡頭", shot_id=command[key])
    timeline = ctx.edit(change, reconcile=True)
    kept = [clip_id for clip_id in result["trimmed"] if any(clip["clip_id"] == clip_id for clip in timeline["clips"])]
    summary = f"已套用較短的 take：修剪 {len(kept)} 個片段、移除 {result['removed']} 個片段"
    return Applied("reconcile", summary, clip_ids=kept, source_ids=result["sources"])


def _set_enabled(ctx: _Context, command: Mapping[str, Any]) -> Applied:
    enabled = command["enabled"] is True
    changed: list[str] = []
    ctx.edit(
        lambda draft, _origins: changed.extend(
            arrange.set_enabled(draft, list(command["clip_ids"]), enabled, _linked(command))
        )
    )
    return Applied("set_enabled", f"已{'啟用' if enabled else '停用'} {len(changed)} 個片段", clip_ids=changed)


HANDLERS: Mapping[str, Handler] = {
    "assemble": _assemble,
    "place": _place,
    "move": _move,
    "trim": _trim,
    "slip": _slip,
    "slide": _slide,
    "split": _split,
    "remove": _remove,
    "set_clip": _set_clip,
    "transition": _transition,
    "add_text": _add_text,
    "add_adjustment": _add_adjustment,
    "track": _track,
    "marker": _marker,
    "caption": _caption,
    "work_area": _work_area,
    "master": _master,
    "join": _join,
    "rearrange": _rearrange,
    "reconcile": _reconcile,
    "set_enabled": _set_enabled,
}


def execute_command(project: Mapping[str, Any], command: Any, allocate: AllocateId) -> tuple[Doc, Applied]:
    """Apply one command: (the new project, what the command did). The input project is not modified."""
    op = check_command(command)
    ctx = _Context(dict(project), allocate)
    applied = HANDLERS[op](ctx, command)
    return ctx.project, applied


def apply_command(project: Mapping[str, Any], command: Any, allocate_id: AllocateId) -> Doc:
    """The project after one command; raises :class:`TimelineRejected` and changes nothing when it is refused."""
    return execute_command(project, command, allocate_id)[0]


def apply_commands(
    project: Mapping[str, Any], commands: Sequence[Any], allocate_id: AllocateId
) -> tuple[Doc, list[Doc]]:
    """The transaction of the commands endpoint: (the normalized project after every command, one entry each).

    All or nothing: a refused command raises ``STUDIO_TIMELINE_REJECTED`` with ``details.command_index`` and a
    stable ``details.reason``.
    """
    current: Doc = normalize_project(project)
    applied: list[Doc] = []
    for index, command in enumerate(commands):
        try:
            current, done = execute_command(current, command, allocate_id)
        except TimelineRejected as rejection:
            raise rejection.to_error(command_index=index) from rejection
        applied.append(done.to_dict())
    result = normalize_project(current)
    try:
        if result.get("timeline") is not None:
            edits.validated(result["timeline"])
    except TimelineRejected as rejection:
        raise rejection.to_error() from rejection
    return result, applied


def request_error(body: Any) -> ComponentError | None:
    """The refusal of a malformed commands request that names the first bad command, when one can be named."""
    commands = body.get("commands") if isinstance(body, Mapping) else None
    if not isinstance(commands, list):
        return None
    for index, command in enumerate(commands[:MAX_COMMANDS]):
        try:
            check_command(command)
        except TimelineRejected as rejection:
            return rejection.to_error(command_index=index)
    return None


__all__ = [
    "COMMAND_DEFS",
    "Applied",
    "apply_command",
    "apply_commands",
    "check_command",
    "execute_command",
    "request_error",
]
