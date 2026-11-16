// Premiere's Paste Attributes: what of the copied clip goes onto the selected clips. The picture's attributes come from
// the first copied clip on a video track, the sound's from the first on an audio track. Motion, Opacity and Volume
// replace the target's values and keys; Time replaces its speed, holds and frame step (the clip is retimed as when
// they are typed in Effect Controls); Effects replaces the colour, camera move, impact frames, picture fades and mask
// the copied clip has and adds its effect stack after the target's. Keys keep their distance from the clip's start
// (a curve that runs past a shorter clip is cut at its end). Everything chosen is one document, one step of the
// history; a clip that cannot take it refuses the whole paste, with its name and the reason. Pure.
import type { MediaClipEffects, StudioTimeline, TimelineClip, TimelineKeyframe, TimelineMotion } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { ClipClipboard } from "./clipboard";
import { executeEdit } from "./commands";
import { curveSlice } from "./curves";
import { mapClipKeyframes } from "./animation";
import { processedDuration, selectClips, windowBounds, type AllocateId, type MotionChannel, type TimelineResult } from "./model";
import { withFade } from "./panels/controls/fades";

export type PasteAttribute = "motion" | "opacity" | "time" | "volume" | "effects";

export interface AttributeChoice {
  id: PasteAttribute;
  label: string;
  /** What it carries over. */
  detail: string;
  /** Why it cannot be pasted now; null when it can. */
  reason: string | null;
}

const NAMES: Record<PasteAttribute, { label: string; detail: string }> = {
  motion: { label: t("運動"), detail: t("位置、縮放、旋轉與它們的關鍵影格") },
  opacity: { label: t("不透明度"), detail: t("不透明度、它的關鍵影格與混合模式") },
  time: { label: t("時間"), detail: t("速度、開頭與結尾停格、拍數") },
  volume: { label: t("音量"), detail: t("音量、聲像、靜音與它們的關鍵影格") },
  effects: { label: t("調色與效果"), detail: t("調色、效果堆疊、遮罩、鏡頭運動、衝擊格與影像淡化") },
};

const ORDER: readonly PasteAttribute[] = ["motion", "opacity", "time", "volume", "effects"];

interface Sources {
  picture: TimelineClip | null;
  sound: TimelineClip | null;
}

function sourcesOf(clipboard: ClipClipboard): Sources {
  const ordered = [...clipboard.clips].sort((a, b) => a.start_frame - b.start_frame);
  const on = (kind: "video" | "audio") => ordered.find((clip) => clipboard.layers[clip.track_id]?.kind === kind) ?? null;
  return { picture: on("video"), sound: on("audio") };
}

/** The clips that take the paste (linked partners of selected clips too, as they are highlighted), by track kind. */
function targetsOf(timeline: StudioTimeline, selected: readonly string[], linked: boolean): { clip: TimelineClip; sound: boolean }[] {
  const audio = new Set(timeline.tracks.filter((track) => track.kind === "audio").map((track) => track.track_id));
  return selectClips(timeline, selected, linked).map((clip) => ({ clip, sound: audio.has(clip.track_id) }));
}

function hasEffects(clip: TimelineClip): boolean {
  const fx = clip.effects ?? {};
  return fx.color !== undefined || fx.camera !== undefined || fx.impact !== undefined || (fx.fade?.video_in ?? 0) > 0 || (fx.fade?.video_out ?? 0) > 0 || (clip.effect_stack?.length ?? 0) > 0 || clip.mask !== undefined;
}

/** The attributes the dialog offers, each with the reason it cannot be pasted onto the selection now. */
export function attributeChoices(timeline: StudioTimeline, clipboard: ClipClipboard, selected: readonly string[], linked: boolean): AttributeChoice[] {
  const { picture, sound } = sourcesOf(clipboard);
  const targets = targetsOf(timeline, selected, linked);
  const pictures = targets.some((target) => !target.sound);
  const sounds = targets.some((target) => target.sound);
  const noPicture = t("複製的片段沒有畫面");
  const noPictureTarget = t("選取的片段沒有畫面");
  const reasons: Record<PasteAttribute, string | null> = {
    motion: !picture ? noPicture : !pictures ? noPictureTarget : null,
    opacity: !picture ? noPicture : !pictures ? noPictureTarget : null,
    time: targets.length === 0 ? t("請先選取要貼上屬性的片段") : null,
    volume: !sound ? t("複製的片段沒有聲音") : !sounds ? t("選取的片段沒有聲音") : null,
    effects: !picture || !hasEffects(picture) ? t("複製的片段沒有效果") : !pictures ? noPictureTarget : null,
  };
  return ORDER.map((id) => ({ id, ...NAMES[id], reason: reasons[id] }));
}

/** A copied curve on the target: the same distance from the clip's start, cut at the target's ends when it runs past them. */
function movedKeys(keys: readonly TimelineKeyframe[] | undefined, fallback: number, source: TimelineClip, target: TimelineClip): TimelineKeyframe[] {
  if (!keys?.length) return [];
  const offset = windowBounds(target).start_frame - windowBounds(source).start_frame;
  const limit = processedDuration(target);
  const moved = keys.map((key) => ({ ...structuredClone(key), frame: key.frame + offset }));
  return moved.every((key) => key.frame >= 0 && key.frame <= limit) ? moved : curveSlice(keys, -offset, limit - offset, fallback);
}

function motionWith(target: TimelineClip, source: TimelineClip, channels: readonly MotionChannel[]): TimelineMotion {
  const motion: TimelineMotion = { ...target.motion, keyframes: { ...target.motion.keyframes } };
  for (const channel of channels) {
    motion[channel] = source.motion[channel];
    const keys = movedKeys(source.motion.keyframes[channel], source.motion[channel], source, target);
    if (keys.length > 0) motion.keyframes[channel] = keys;
    else delete motion.keyframes[channel];
  }
  return motion;
}

/** The copied clip's effect stack and mask with their keys moved onto the target (the stack under new ids). */
function compositingFor(source: TimelineClip, target: TimelineClip, allocate: AllocateId): Pick<TimelineClip, "effect_stack" | "mask"> {
  const moved = mapClipKeyframes({ ...source, motion: { ...source.motion, keyframes: {} } }, (keys, fallback) => movedKeys(keys, fallback, source, target));
  const stack = (moved.effect_stack ?? []).map((effect) => ({ ...effect, effect_id: allocate("fx") }));
  return {
    effect_stack: [...(target.effect_stack ?? []), ...stack],
    ...(moved.mask ? { mask: moved.mask } : target.mask ? { mask: target.mask } : {}),
  };
}

function pictureEffects(target: MediaClipEffects, source: MediaClipEffects): MediaClipEffects {
  const next: MediaClipEffects = { ...target };
  if (source.color) next.color = structuredClone(source.color);
  if (source.camera) next.camera = structuredClone(source.camera);
  if (source.impact) next.impact = structuredClone(source.impact);
  const fades = (source.fade?.video_in ?? 0) > 0 || (source.fade?.video_out ?? 0) > 0;
  return fades ? withFade(next, { video_in: source.fade?.video_in ?? 0, video_out: source.fade?.video_out ?? 0 }) : next;
}

/** The copied timing, written as the panels write it: values at their defaults are left out (sound has no frame step). */
function timeEffects(target: MediaClipEffects, source: MediaClipEffects, sound: boolean): MediaClipEffects {
  const { speed_percent: _speed, hold: _hold, frame_step: _step, ...rest } = target;
  const speed = source.speed_percent ?? 100;
  const hold = { start: source.hold?.start ?? 0, end: source.hold?.end ?? 0 };
  const step = sound ? 1 : (source.frame_step ?? 1);
  return {
    ...rest,
    ...(speed !== 100 ? { speed_percent: speed } : {}),
    ...(hold.start > 0 || hold.end > 0 ? { hold } : {}),
    ...(step !== 1 ? { frame_step: step } : {}),
  };
}

/** Effects of a clip that may have none: an empty group is left out, as the panels leave it. */
function effectsOrNone(effects: MediaClipEffects): Pick<TimelineClip, "effects"> {
  return { effects: Object.keys(effects).length > 0 ? effects : undefined };
}

/** The clip with the chosen attributes of the copied clips. */
function pastedOnto(target: TimelineClip, sound: boolean, sources: Sources, chosen: ReadonlySet<PasteAttribute>, allocate: AllocateId): TimelineClip {
  let clip: TimelineClip = target;
  const picture = sources.picture;
  if (!sound && picture) {
    const channels: MotionChannel[] = [...(chosen.has("motion") ? (["x", "y", "scale", "rotation"] as const) : []), ...(chosen.has("opacity") ? (["opacity"] as const) : [])];
    if (channels.length > 0) clip = { ...clip, motion: motionWith(clip, picture, channels) };
    if (chosen.has("opacity")) {
      const { blend_mode: _blend, ...rest } = clip;
      clip = picture.blend_mode ? { ...rest, blend_mode: picture.blend_mode } : rest;
    }
    if (chosen.has("effects")) clip = { ...clip, ...effectsOrNone(pictureEffects(clip.effects ?? {}, picture.effects ?? {})), ...compositingFor(picture, clip, allocate) };
  }
  const heard = sources.sound;
  if (sound && heard && chosen.has("volume")) {
    clip = { ...clip, motion: motionWith(clip, heard, ["gain_db", "pan"]) };
    const { volume_db: _volume, mute: _mute, ...rest } = clip.effects ?? {};
    clip = { ...clip, ...effectsOrNone({ ...rest, ...(heard.effects?.volume_db !== undefined ? { volume_db: heard.effects.volume_db } : {}), ...(heard.effects?.mute ? { mute: true } : {}) }) };
  }
  const timed = sound ? (heard ?? picture) : (picture ?? heard);
  if (chosen.has("time") && timed) clip = { ...clip, ...effectsOrNone(timeEffects(clip.effects ?? {}, timed.effects ?? {}, sound)) };
  return clip;
}

/** Pastes the chosen attributes onto the selected clips as one document; refused as a whole with the clip and the reason. */
export function pasteAttributes(
  timeline: StudioTimeline,
  clipboard: ClipClipboard,
  selected: readonly string[],
  linked: boolean,
  chosen: ReadonlySet<PasteAttribute>,
  allocate: AllocateId,
): TimelineResult<{ timeline: StudioTimeline; count: number }> {
  const sources = sourcesOf(clipboard);
  const targets = targetsOf(timeline, selected, linked);
  if (targets.length === 0) return { ok: false, error: t("請先選取要貼上屬性的片段") };
  if (chosen.size === 0) return { ok: false, error: t("請至少選一項屬性") };
  let current = timeline;
  for (const { clip: original, sound } of targets) {
    // An earlier clip of the paste may have retimed this one (a linked partner): continue from the document as it is now
    const target = current.clips.find((clip) => clip.clip_id === original.clip_id);
    if (!target) continue;
    const { name, effects, motion, effect_stack, mask, blend_mode } = pastedOnto(target, sound, sources, chosen, allocate);
    const result = executeEdit(current, { type: "patchClip", clipId: target.clip_id, linked, patch: { name, effects, motion, effect_stack, mask, blend_mode } }, allocate);
    if (!result.ok) return { ok: false, error: t("「{clip}」：{reason}", { clip: target.name, reason: result.error }) };
    current = result.value;
  }
  return { ok: true, value: { timeline: current, count: targets.length } };
}
