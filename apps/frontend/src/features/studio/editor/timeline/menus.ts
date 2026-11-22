// Context menus of the timeline (clip, transition, empty track area, track header, ruler). They carry the actions
// that have no button in the chrome; every unavailable action stays in the menu with its reason.
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  CopyPlus,
  CornerDownLeft,
  CornerDownRight,
  Crosshair,
  Eye,
  EyeOff,
  Flag,
  FolderSearch,
  Gauge,
  Hourglass,
  Link2,
  PencilLine,
  Plus,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  SquareSplitHorizontal,
  Trash2,
  Type,
  Unlink2,
  Wand2,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type { TimelineClip, TimelineTrack } from "@/api/generated/contracts";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import {
  activeTransition,
  DEFAULT_TRANSITION_FRAMES,
  isMoving,
  TRANSITION_ALIGNMENT_LABELS,
  TRANSITION_ALIGNMENTS,
  TRANSITION_DIRECTION_LABELS,
  TRANSITION_DIRECTIONS,
  TRANSITION_KINDS,
  TRANSITION_LABELS,
  type TransitionAlignment,
  type TransitionDirection,
  type TransitionKind,
  type TransitionOptions,
} from "../../model/clipEffects";
import { hasMotionReference } from "../../speedfeel/target";
import { ADJUSTMENT_TRANSITION, isAdjustment } from "../adjustment";
import type { Editor } from "../editorContext";
import { clipEnabled, clipEnd, sourceFrameAtTimeline, trackClips } from "../model";
import { requestClipFix } from "../../fix/fixStore";
import { restoreTakeProblem } from "../restoreTake";
import { cutOf } from "../transitionCut";

const mod = (key: string) => `${modifierLabel("Mod", detectApplePlatform())}+${key}`;
const modAlt = (key: string) => mod(`${modifierLabel("Alt", detectApplePlatform())}+${key}`);

/**
 * Paste (an overwrite at the playhead), paste insert and, on a clip, paste attributes: the menus' paste items. The
 * clip a menu opens on is the selection by then, so only a missing clipboard keeps paste attributes from it.
 */
function pasteItems(editor: Editor, attributes: boolean): MenuItem[] {
  const copied = editor.clipboard ? null : t("請先複製時間軸片段");
  return [
    { id: "paste", label: t("貼上（在播放頭覆寫）"), icon: ClipboardPaste, shortcut: mod("V"), disabledReason: editor.pasteBlocked, onSelect: () => { editor.paste("overwrite"); } },
    { id: "paste-insert", label: t("貼上插入"), icon: ClipboardPaste, shortcut: mod("Shift+V"), disabledReason: editor.pasteBlocked, onSelect: () => { editor.paste("insert"); } },
    ...(attributes
      ? [{ id: "paste-attributes", label: t("貼上屬性…"), icon: ClipboardPaste, shortcut: modAlt("V"), disabledReason: copied, onSelect: () => { editor.ui.setPastingAttributes(true); } }]
      : []),
  ];
}

const DIRECTION_ICONS: Record<TransitionDirection, LucideIcon> = { left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown, in: ZoomIn, out: ZoomOut };
const ALIGNMENT_ICONS: Record<TransitionAlignment, LucideIcon> = { center: AlignHorizontalJustifyCenter, start: AlignHorizontalJustifyStart, end: AlignHorizontalJustifyEnd };

/** The clip that follows on the same track, when it starts where this one ends (a cut a transition can sit on). */
function cutAfter(editor: Editor, clip: TimelineClip): TimelineClip | null {
  const ordered = trackClips(editor.timeline, clip.track_id);
  const next = ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) + 1];
  const overlap = activeTransition(clip.effects)?.frames ?? 0;
  return next?.start_frame === clipEnd(clip) - overlap ? next : null;
}

export function clipMenu(editor: Editor, clip: TimelineClip): MenuItem[] {
  const locked = (editor.trackOf(clip)?.locked === true) ? t("軌道已鎖定；請先解鎖再編輯") : null;
  const transition = activeTransition(clip.effects);
  const shorter = editor.shorterTakes.find((item) => item.sourceId === clip.source_id);
  const next = cutAfter(editor, clip);
  const adjustment = isAdjustment(editor.timeline, clip);
  // A text or an adjustment layer is made on the timeline: it has no media in the project and no source frames
  const kind = editor.sourceOf(clip)?.kind;
  const noMedia = kind === "adjustment" ? t("調整圖層沒有專案素材") : kind === "text" ? t("文字圖層沒有專案素材") : null;
  const noFrames = kind === "adjustment" ? t("調整圖層沒有來源影格") : kind === "text" ? t("文字圖層沒有來源影格") : null;
  const noCut = !next ? t("這個片段後面沒有緊鄰的片段") : adjustment || isAdjustment(editor.timeline, next) ? ADJUSTMENT_TRANSITION : null;
  const frame = editor.playhead.getFrame();
  const inside = frame >= clip.start_frame && frame < clipEnd(clip);
  return [
    { id: "cut", label: t("剪下"), icon: Scissors, shortcut: mod("X"), disabledReason: locked, onSelect: editor.cut },
    { id: "copy", label: t("複製"), icon: Copy, shortcut: mod("C"), onSelect: () => void editor.copy() },
    ...pasteItems(editor, true),
    { id: "duplicate", label: t("複製一份"), icon: CopyPlus, disabledReason: editor.canDuplicate ? null : locked, onSelect: editor.duplicate },
    { id: "split", label: t("在播放頭新增編輯點"), icon: SquareSplitHorizontal, shortcut: mod("K"), separatorBefore: true, disabledReason: locked, onSelect: () => void editor.split() },
    { id: "delete", label: t("刪除"), icon: Trash2, shortcut: "Delete", disabledReason: locked, onSelect: () => void editor.remove(false) },
    { id: "ripple-delete", label: t("波紋刪除"), icon: Trash2, shortcut: "Shift+Delete", disabledReason: locked, onSelect: () => void editor.remove(true) },
    ...(editor.selected.length > 1
      ? [{ id: "link", label: t("連結"), icon: Link2, shortcut: mod("L"), separatorBefore: true, onSelect: () => void editor.command({ type: "link", clipIds: editor.selected }) }]
      : []),
    ...((clip.linked_id != null && clip.linked_id !== "")
      ? [{ id: "unlink", label: t("取消連結"), icon: Unlink2, shortcut: mod("L"), separatorBefore: editor.selected.length <= 1, onSelect: () => void editor.command({ type: "unlink", clipIds: editor.selected }) }]
      : []),
    ...(transition
      ? [{ id: "transition-remove", label: t("移除轉場"), icon: X, separatorBefore: true, onSelect: () => void editor.command({ type: "transition", clipId: clip.clip_id, kind: "cut", frames: 0, linked: editor.linked }) }]
      : TRANSITION_KINDS.map(
          (kind, index): MenuItem => ({
            id: `transition-${kind}`,
            label: t("在出點加上{name}", { name: TRANSITION_LABELS[kind] }),
            icon: Hourglass,
            separatorBefore: index === 0,
            disabledReason: locked ?? noCut,
            onSelect: () => void editor.command({ type: "transition", clipId: clip.clip_id, kind, frames: DEFAULT_TRANSITION_FRAMES, linked: editor.linked }),
          }),
        )),
    ...(shorter ? [{ id: "shorter", label: t("套用較短的新 take 並裁短片段…"), icon: Scissors, separatorBefore: true, onSelect: () => { editor.requestShorter(shorter); } }] : []),
    fixItem(editor, clip, !shorter),
    ...restoreTakeItems(editor, clip, locked, false),
    { id: "enable", label: clipEnabled(clip) ? t("停用片段") : t("啟用片段"), icon: clipEnabled(clip) ? EyeOff : Eye, shortcut: "Shift+E", separatorBefore: true, disabledReason: locked, onSelect: () => void editor.toggleEnabled() },
    { id: "speed", label: t("速度與持續時間…"), icon: Gauge, disabledReason: adjustment ? t("調整圖層沒有自己的時間：不能變速或停格") : null, onSelect: () => { editor.ui.request({ panel: "controls", field: "speed" }); } },
    ...speedFeelItems(editor, clip),
    { id: "rename", label: t("重新命名…"), icon: PencilLine, onSelect: () => { editor.ui.request({ panel: "controls", field: "name" }); } },
    { id: "reveal", label: t("在專案中顯示"), icon: FolderSearch, separatorBefore: true, disabledReason: noMedia, onSelect: () => { revealInProject(editor, clip); } },
    { id: "match", label: t("符合影格"), icon: Crosshair, disabledReason: noFrames ?? (inside ? null : t("播放頭不在這個片段上")), onSelect: () => { matchFrame(editor, clip, frame); } },
  ];
}

/**
 * 修正…: the 修正 menu of the clip's take (fix/), shown next to the clip; a clip that is no shot's take says why not.
 */
function fixItem(editor: Editor, clip: TimelineClip, separatorBefore: boolean): MenuItem {
  const source = editor.sourceOf(clip);
  const origin = source?.candidate_origin ?? source;
  const reason = origin?.shot_id != null && origin.shot_id !== "" && origin.take_id != null && origin.take_id !== "" ? null : t("這個片段不是鏡頭的 take");
  return { id: "fix", label: t("修正…"), icon: Wand2, separatorBefore, disabledReason: reason, onSelect: () => { requestClipFix(clip.clip_id); } };
}

/**
 * 還原為整段 take: on a shot's clip, the pieces it was cut into for one take (splits, speed, holds) become the whole
 * take again over the same span; the reason says why not (already whole, linked, the take too short for the span).
 */
function restoreTakeItems(editor: Editor, clip: TimelineClip, locked: string | null, separatorBefore: boolean): MenuItem[] {
  const shotId = editor.sourceOf(clip)?.shot_id;
  if (!(shotId != null && shotId !== "")) return [];
  const inFrame = editor.project.shots.find((shot) => shot.shot_id === shotId)?.in_frame ?? 0;
  return [
    {
      id: "restore-take",
      label: t("還原為整段 take"),
      icon: RotateCcw,
      separatorBefore,
      disabledReason: locked ?? restoreTakeProblem(editor.timeline, clip.clip_id, inFrame),
      onSelect: () => void editor.command({ type: "restoreTake", clipId: clip.clip_id, inFrame }),
    },
  ];
}

/** 速度感…: on a video clip whose shot has a @Video1 reference (the dialog says why a clip cannot be analysed). */
function speedFeelItems(editor: Editor, clip: TimelineClip): MenuItem[] {
  if (!hasMotionReference(editor.project, editor.timeline, clip)) return [];
  return [{ id: "speedfeel", label: t("速度感…"), icon: Zap, onSelect: () => { editor.ui.setSpeedFeelClip(clip.clip_id); } }];
}

/** Show the clip's media in the Project panel (it becomes the loaded source). */
function revealInProject(editor: Editor, clip: TimelineClip): void {
  editor.setSourceId(clip.source_id);
  editor.ui.request({ panel: "project" });
}

/** Match frame: load the clip's media in the Source monitor at the source frame under the playhead. */
function matchFrame(editor: Editor, clip: TimelineClip, frame: number): void {
  editor.setSourceId(clip.source_id);
  editor.ui.request({ panel: "source", frame: Math.round(sourceFrameAtTimeline(clip, frame)) });
}

/**
 * A transition's menu: its length, where it sits on the cut, another kind (it keeps its length and, where it can, its
 * direction), where a moving one goes.
 */
export function transitionMenu(editor: Editor, clip: TimelineClip): MenuItem[] {
  const transition = activeTransition(clip.effects);
  if (!transition) return [];
  const command = (kind: TransitionKind, frames: number, options?: TransitionOptions, alignment?: TransitionAlignment) =>
    editor.command({ type: "transition", clipId: clip.clip_id, kind, frames, ...(options === undefined ? {} : { options }), ...(alignment === undefined ? {} : { alignment }), linked: editor.linked });
  const set = (frames: number) => command(transition.kind, frames);
  const moving = isMoving(transition) ? transition : null;
  const current = cutOf(transition).alignment;
  return [
    ...[6, 12, 24].map(
      (frames): MenuItem => ({ id: `frames-${String(frames)}`, label: t("長度 {frames} 影格", { frames }), icon: Hourglass, disabledReason: transition.frames === frames ? t("已是這個長度") : null, onSelect: () => void set(frames) }),
    ),
    ...TRANSITION_ALIGNMENTS.map(
      (alignment, index): MenuItem => ({
        id: `alignment-${alignment}`,
        label: t("對齊：{alignment}", { alignment: TRANSITION_ALIGNMENT_LABELS[alignment] }),
        icon: ALIGNMENT_ICONS[alignment],
        separatorBefore: index === 0,
        disabledReason: current === alignment ? t("已是這個對齊方式") : null,
        onSelect: () => void command(transition.kind, transition.frames, undefined, alignment),
      }),
    ),
    ...(moving
      ? TRANSITION_DIRECTIONS[moving.kind].map(
          (direction, index): MenuItem => ({
            id: `direction-${direction}`,
            label: t("方向：{direction}", { direction: TRANSITION_DIRECTION_LABELS[direction] }),
            icon: DIRECTION_ICONS[direction],
            separatorBefore: index === 0,
            disabledReason: moving.direction === direction ? t("已是這個方向") : null,
            onSelect: () => void command(moving.kind, moving.frames, { direction }),
          }),
        )
      : []),
    ...TRANSITION_KINDS.filter((kind) => kind !== transition.kind).map(
      (kind, index): MenuItem => ({
        id: `kind-${kind}`,
        label: t("改為{name}", { name: TRANSITION_LABELS[kind] }),
        icon: Hourglass,
        separatorBefore: index === 0,
        onSelect: () => void command(kind, transition.frames),
      }),
    ),
    { id: "remove", label: t("移除轉場"), icon: Trash2, shortcut: "Delete", tone: "danger", separatorBefore: true, onSelect: () => void editor.command({ type: "transition", clipId: clip.clip_id, kind: "cut", frames: 0, linked: editor.linked }) },
  ];
}

export function gapMenu(editor: Editor, frame: number): MenuItem[] {
  return [
    { id: "seek", label: t("把播放頭移到這裡"), onSelect: () => { editor.transport.seek(frame); } },
    ...pasteItems(editor, false),
    { id: "marker", label: t("新增標記"), icon: Flag, shortcut: "M", separatorBefore: true, onSelect: () => void editor.addMarker() },
    { id: "text", label: t("新增文字圖層"), icon: Type, shortcut: "T", onSelect: editor.addTextLayer },
    { id: "adjustment", label: t("新增調整圖層"), icon: SlidersHorizontal, onSelect: editor.addAdjustmentLayer },
  ];
}

export function trackMenu(editor: Editor, track: TimelineTrack, rename: () => void): MenuItem[] {
  // Rows show video tracks top-down, so "up" is the next layer for video and the previous row for audio
  const peers = editor.timeline.tracks.filter((item) => item.kind === track.kind);
  const rows = track.kind === "video" ? [...peers].reverse() : peers;
  const at = rows.findIndex((item) => item.track_id === track.track_id);
  const swap = (delta: number): MenuItem => {
    const target = rows[at + delta];
    const reason = !target ? (delta < 0 ? t("已經在最上面") : t("已經在最下面")) : track.locked || target.locked ? t("軌道已鎖定；請先解鎖再編輯") : null;
    return {
      id: delta < 0 ? "up" : "down",
      label: delta < 0 ? t("上移軌道") : t("下移軌道"),
      icon: delta < 0 ? ArrowUp : ArrowDown,
      disabledReason: reason,
      onSelect: () => (target ? void editor.command({ type: "reorderTrack", trackId: track.track_id, targetId: target.track_id }) : undefined),
    };
  };
  const occupied = editor.timeline.clips.some((clip) => clip.track_id === track.track_id);
  const full = editor.canAddTrack ? null : t("軌道數已達上限");
  return [
    { id: "rename", label: t("重新命名"), onSelect: rename },
    { id: "add-video", label: t("新增視訊軌"), icon: Plus, separatorBefore: true, disabledReason: full, onSelect: () => void editor.addTrack("video") },
    { id: "add-audio", label: t("新增音訊軌"), icon: Plus, disabledReason: full, onSelect: () => void editor.addTrack("audio") },
    { ...swap(-1), separatorBefore: true },
    swap(1),
    {
      id: "remove",
      label: t("刪除空軌道"),
      icon: Trash2,
      tone: "danger",
      separatorBefore: true,
      disabledReason: track.locked ? t("軌道已鎖定；請先解鎖再編輯") : occupied ? t("軌道仍有片段；請先移動或移除片段") : null,
      onSelect: () => void editor.command({ type: "removeTrack", trackId: track.track_id }),
    },
  ];
}

export function rulerMenu(editor: Editor): MenuItem[] {
  const area = editor.timeline.work_area;
  const none = area ? null : t("還沒有標記序列入出點");
  return [
    { id: "mark-in", label: t("標記入點"), icon: CornerDownLeft, shortcut: "I", onSelect: () => { editor.markRange("in"); } },
    { id: "mark-out", label: t("標記出點"), icon: CornerDownRight, shortcut: "O", onSelect: () => { editor.markRange("out"); } },
    { id: "clear", label: t("清除入點和出點"), icon: X, disabledReason: none, onSelect: editor.clearWorkArea },
    { id: "lift", label: t("提升"), shortcut: ";", separatorBefore: true, disabledReason: none, onSelect: () => { editor.removeRange(false); } },
    { id: "extract", label: t("擷取"), shortcut: "'", disabledReason: none, onSelect: () => { editor.removeRange(true); } },
    { id: "marker", label: t("新增標記"), icon: Flag, shortcut: "M", separatorBefore: true, onSelect: () => void editor.addMarker() },
  ];
}
