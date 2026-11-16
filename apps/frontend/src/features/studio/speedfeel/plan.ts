// The timeline edit of a speed-feel analysis (pure): one clip is split at its hits and every part that starts on a hit
// gets the recipe's effects, all of it as one new document (the caller records it as one history step, so one undo
// takes it back). Only the editor's own commands are used (executeEdit "split" and "patchClip"), so the result passes
// the same checks as a hand edit:
// - nothing moves: a split keeps every frame where it was, so the clip's length, everything after it and the sync with
//   the soundtrack stay as they are;
// - sound: a clip linked to its own sound (the take's audio) is split together with it, at the same frames, and the
//   sound parts follow each other without a gap; the picture-only effects go on the picture alone. A clip without a
//   link (the swap's original soundtrack is a separate clip) is split alone;
// - refused, with the reason: a locked track, retiming, holds or frame stepping (the frames would not map one to one),
//   shake or an impact frame already on the clip (the split parts would repeat them), keyframe animation (the parts
//   could not take effects afterwards);
// - a hit whose split would land in a transition or in a fade, or that the editor's own split refuses (a linked clip's
//   transition), is left out with its reason; the others still apply.
import type { MediaClipEffects, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit } from "../editor/commands";
import type { Hit } from "./analysis";
import { hasKeys, hasShake, linkedPeers, lockRefusal, zoneOf } from "./conform";
import { retimingReason } from "./target";

export interface PlannedHit extends Hit {
  /** The sequence frame the clip is split at. */
  at: number;
}

export interface BlockedHit extends Hit {
  reason: string;
}

export interface SpeedFeelPlan {
  /** The edited document. */
  timeline: StudioTimeline;
  hits: PlannedHit[];
  blocked: BlockedHit[];
  /** The clip's linked clips (its sound) are split with it. */
  linked: boolean;
}

export type SpeedFeelPlanResult = { ok: true; plan: SpeedFeelPlan } | { ok: false; reason: string; blocked: BlockedHit[] };

/** Why the clip cannot take the edit at all; null when it can. */
function clipRefusal(timeline: StudioTimeline, clip: TimelineClip): string | null {
  const locked = lockRefusal(timeline, clip, linkedPeers(timeline, clip));
  if (locked) return locked;
  const retimed = retimingReason(clip);
  if (retimed) return retimed;
  if (hasShake(clip)) return t("這個片段已經有震動：請先在「效果控制」重設鏡頭運動");
  if (clip.effects?.impact) return t("這個片段已經有衝擊格：請先在「效果控制」關閉衝擊格");
  if (hasKeys(clip)) return t("這個片段有關鍵影格動畫：分割後無法再加效果，請先移除關鍵影格");
  return null;
}

/** The part's effects with the hit's added (camera keeps a zoom the clip had). */
function partEffects(effects: MediaClipEffects | undefined, hit: Hit): MediaClipEffects {
  const next: MediaClipEffects = { ...effects };
  if (hit.effects.camera) next.camera = { ...effects?.camera, ...hit.effects.camera };
  if (hit.effects.impact) next.impact = { ...hit.effects.impact };
  return next;
}

/** The edit of `hits` (in frame order) on the clip `clipId` of `timeline`; a reason when it cannot be made. */
export function planSpeedFeel(timeline: StudioTimeline, clipId: string, hits: readonly Hit[]): SpeedFeelPlanResult {
  const clip = timeline.clips.find((item) => item.clip_id === clipId);
  if (!clip) return { ok: false, reason: t("找不到這個片段（可能已經刪除，或被復原拿掉了）"), blocked: [] };
  const refusal = clipRefusal(timeline, clip);
  if (refusal) return { ok: false, reason: refusal, blocked: [] };
  const linked = clip.linked_id !== undefined;
  const blocked: BlockedHit[] = [];
  const planned: PlannedHit[] = [];
  let document = timeline;
  // The clip's own transitions and fades keep a split out: a part that starts inside a fade cannot be given effects (the
  // fade's phase would be lost). Its impact frames never do: such a clip is refused above
  const zone = zoneOf(timeline, [clip]);
  // The clip keeps its id as the first part: split from the last hit backwards; a split the editor refuses leaves its hit out
  for (const hit of [...hits].reverse()) {
    const at = clip.start_frame + hit.accent.frame;
    const reason = zone(hit.accent.frame);
    const split = reason === null ? executeEdit(document, { type: "split", clipIds: [clip.clip_id], frame: at, linked }) : { ok: false as const, error: reason };
    if (split.ok) {
      document = split.value;
      planned.unshift({ ...hit, at });
    } else blocked.unshift({ ...hit, reason: split.error });
  }
  if (planned.length === 0) return { ok: false, reason: t("每個切點都不能用（原因列在上面的表格）"), blocked };
  for (const hit of planned) {
    const part = document.clips.find((item) => item.track_id === clip.track_id && item.source_id === clip.source_id && item.start_frame === hit.at);
    if (!part) return { ok: false, reason: t("找不到分割後的片段"), blocked };
    const result = executeEdit(document, { type: "patchClip", clipId: part.clip_id, patch: { effects: partEffects(part.effects, hit) }, linked: false });
    if (!result.ok) return { ok: false, reason: result.error, blocked };
    document = result.value;
  }
  return { ok: true, plan: { timeline: document, hits: planned, blocked, linked } };
}
