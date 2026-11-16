// The name of a history step, as the History panel lists it: from the command that was run, or, for an edit that a
// panel wrote directly, from what differs between the two documents. Pure.
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { EditCommand } from "./commands";

type ClipPatch = Extract<EditCommand, { type: "patchClip" }>["patch"];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What an effects change is about: the first group of settings that differs. */
function effectsLabel(before: TimelineClip["effects"], after: TimelineClip["effects"]): string {
  const a = before ?? {};
  const b = after ?? {};
  if (!same(a.transition_out, b.transition_out)) return t("調整轉場");
  if (!same(a.color, b.color)) return t("調整色彩");
  if (!same(a.title, b.title)) return t("調整文字");
  if (!same(a.speed_percent, b.speed_percent) || !same(a.hold, b.hold) || !same(a.frame_step, b.frame_step)) return t("調整時間");
  if (!same(a.camera, b.camera)) return t("調整鏡頭運動");
  if (!same(a.impact, b.impact)) return t("調整衝擊格");
  if (!same(a.volume_db, b.volume_db) || !same(a.mute, b.mute)) return t("調整音量");
  if (!same(a.fade, b.fade)) return t("調整淡化");
  return t("調整效果");
}

function keyCount(clip: TimelineClip): number {
  return Object.values(clip.motion.keyframes).reduce((total, keys) => total + keys.length, 0);
}

/** What one clip's change is about. */
function clipLabel(before: TimelineClip, after: TimelineClip): string {
  if (before.name !== after.name) return t("重新命名片段");
  if (before.track_id !== after.track_id || before.start_frame !== after.start_frame) return t("移動片段");
  if (before.in_frame !== after.in_frame || before.out_frame !== after.out_frame || !same(before.output_window, after.output_window)) return t("修剪片段");
  if ((before.enabled ?? true) !== (after.enabled ?? true)) return after.enabled === false ? t("停用片段") : t("啟用片段");
  if (!same(before.motion.keyframes, after.motion.keyframes)) {
    // A text that moved takes the keys of its animation presets along: the step is the text's
    if (!same(before.effects?.title, after.effects?.title)) return t("調整文字");
    const added = keyCount(after) - keyCount(before);
    return added > 0 ? t("加入關鍵影格") : added < 0 ? t("移除關鍵影格") : t("調整關鍵影格");
  }
  if (before.motion.opacity !== after.motion.opacity) return t("調整不透明度");
  if (before.motion.gain_db !== after.motion.gain_db || before.motion.pan !== after.motion.pan) return t("調整音量");
  if (!same(before.motion, after.motion)) return t("調整運動");
  if (!same(before.effects, after.effects)) return effectsLabel(before.effects, after.effects);
  if (!same(before.effect_stack, after.effect_stack)) return t("調整效果");
  if (!same(before.mask, after.mask)) return t("調整遮罩");
  if (before.blend_mode !== after.blend_mode) return t("調整混合模式");
  if (before.linked_id !== after.linked_id) return after.linked_id ? t("連結片段") : t("取消連結");
  return t("調整片段");
}

/** Added, removed or changed, for a list whose items carry an id. */
function listLabel<T>(before: readonly T[], after: readonly T[], labels: { added: string; removed: string; changed: string }): string | null {
  if (same(before, after)) return null;
  if (after.length > before.length) return labels.added;
  if (after.length < before.length) return labels.removed;
  return labels.changed;
}

/** The name of an edit that was written as a whole document: what differs between before and after. */
export function changeLabel(before: StudioTimeline, after: StudioTimeline): string {
  const earlier = new Map(before.clips.map((clip) => [clip.clip_id, clip]));
  const added = after.clips.filter((clip) => !earlier.has(clip.clip_id));
  const kept = new Set(after.clips.map((clip) => clip.clip_id));
  const removed = before.clips.filter((clip) => !kept.has(clip.clip_id));
  if (added.length > 0 && removed.length === 0) {
    const kinds = new Set(added.map((clip) => after.sources.find((source) => source.source_id === clip.source_id)?.kind));
    return kinds.has("text") ? t("新增文字圖層") : kinds.has("adjustment") ? t("新增調整圖層") : t("加入片段");
  }
  if (removed.length > 0 && added.length === 0) return t("刪除片段");
  if (added.length > 0) return t("編輯片段");
  const changed = after.clips.filter((clip) => !same(clip, earlier.get(clip.clip_id)));
  const first = changed[0];
  const original = first ? earlier.get(first.clip_id) : undefined;
  if (first && original) {
    const label = clipLabel(original, first);
    // Linked partners change together: one name covers them when it is the same change
    return changed.every((clip) => clipLabel(earlier.get(clip.clip_id) ?? clip, clip) === label) ? label : t("調整片段");
  }
  return (
    listLabel(before.captions, after.captions, { added: t("新增字幕"), removed: t("刪除字幕"), changed: t("調整字幕") }) ??
    listLabel(before.markers, after.markers, { added: t("新增標記"), removed: t("刪除標記"), changed: t("調整標記") }) ??
    listLabel(before.tracks, after.tracks, { added: t("新增軌道"), removed: t("刪除軌道"), changed: t("調整軌道") }) ??
    (!same(before.work_area, after.work_area) ? (after.work_area ? t("標記範圍") : t("清除標記範圍")) : null) ??
    (before.master_gain_db !== after.master_gain_db ? t("調整主音量") : null) ??
    (!same(before.sources, after.sources) ? t("更新素材") : null) ??
    t("編輯")
  );
}

function patchLabel(patch: ClipPatch): string | null {
  if (patch.name !== undefined) return t("重新命名片段");
  return null;
}

/** The name of a command's step; null leaves it to changeLabel (a patch whose subject only the documents show). */
export function commandLabel(edit: EditCommand): string | null {
  switch (edit.type) {
    case "transition":
      return edit.kind === "cut" ? t("移除轉場") : t("套用轉場");
    case "split":
      return t("分割片段");
    case "place":
      return edit.mode === "insert" ? t("插入") : t("覆寫");
    case "delete":
      return edit.ripple ? t("波紋刪除") : t("刪除片段");
    case "rangeDelete":
      return edit.ripple ? t("擷取") : t("提升");
    case "trim":
      return edit.ripple ? t("波紋修剪") : t("修剪片段");
    case "roll":
      return t("滾動編輯");
    case "slide":
      return t("內滑");
    case "slip":
      return t("外滑");
    case "move":
      return t("移動片段");
    case "rearrange":
      return t("重新排列片段");
    case "reorderTrack":
      return t("調整軌道順序");
    case "link":
      return t("連結片段");
    case "unlink":
      return t("取消連結");
    case "restoreTake":
      return t("還原為整段 take");
    case "patchClip":
      return patchLabel(edit.patch);
    case "patchTrack":
      return t("調整軌道");
    case "addTrack":
      return t("新增軌道");
    case "removeTrack":
      return t("刪除軌道");
  }
}
