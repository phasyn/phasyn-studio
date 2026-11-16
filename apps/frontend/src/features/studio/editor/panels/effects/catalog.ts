// What the Effects browser offers: the transitions and effects the timeline document can express today (the look pack
// included: push, slide, whip, wipe and zoom; glow, RGB split, vignette, grain, directional blur and sharpen), each with
// the edit it makes on the selection through the editor's own commands. An item only plans its command; the browser
// tries the plans on a copy of the timeline to say whether they apply, and runs one when the item is chosen or dropped.
// Pure.
import {
  Aperture,
  ArrowLeftRight,
  Blend,
  Blinds,
  Contrast,
  Droplets,
  Film,
  Focus,
  Hourglass,
  Layers,
  Maximize2,
  MoveHorizontal,
  Palette,
  PanelLeftOpen,
  Pipette,
  Sparkles,
  SunMoon,
  Sunrise,
  Sunset,
  Vibrate,
  Volume1,
  Volume2,
  Wind,
  Zap,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import type { MediaClipEffects, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { DEFAULT_TRANSITION_FRAMES, IMPACT_STYLE_LABELS, IMPACT_STYLES, TRANSITION_LABELS, type ImpactStyle } from "../../../model/clipEffects";
import { executeEdit, type EditCommand } from "../../commands";
import { EFFECT_LIMIT, EFFECT_NAMES, newEffect, type ClipEffect } from "../../compositing";
import { clipEndSpots } from "../../editSpots";
import { clipDuration, type AllocateId } from "../../model";
import { AUDIO_CROSSFADE_LABEL, fadeRoom, planAtSpot, type FadeEdge, type TransitionSpec, type TransitionStyle } from "../../transitionPlacement";

export type EffectCategoryId = "video-transitions" | "video-effects" | "audio";

export interface EffectCategory {
  id: EffectCategoryId;
  label: string;
}

export const EFFECT_CATEGORIES: readonly EffectCategory[] = [
  { id: "video-transitions", label: t("視訊轉場") },
  { id: "video-effects", label: t("視訊效果") },
  { id: "audio", label: t("音訊") },
];

/** What is selected on the timeline, as the items read it. */
export interface EffectSelection {
  timeline: StudioTimeline;
  /** The selected clip (the first one when several are selected). */
  clip: TimelineClip | null;
  /** The outgoing clip of the selected transition. */
  transitionClip: TimelineClip | null;
  /** Linked selection: an edit of a clip takes its linked partners along. */
  linked: boolean;
}

export type EffectPlan =
  | { ok: true; clip: TimelineClip; command: EditCommand }
  /** applied = the selection already carries what the item would add. */
  | { ok: false; reason: string; applied: boolean };

/**
 * What can refuse an item's command beyond its own plan, the same for every item of a family on one clip: a
 * transition on a cut (locks, the clips' lengths, a fade or impact frames at an edge a clip must lend frames beyond),
 * an effect added to the stack, a patch of the clip's own effects that leaves its timing alone, and one that changes
 * the phase of its frames (fades, impact frames, shake), which may need to rebuild a trimmed clip first.
 */
export type EffectFamily = "transition" | "stack" | "patch" | "phase";

export interface EffectItem {
  id: string;
  category: EffectCategoryId;
  label: string;
  icon: LucideIcon;
  /** What it lands on: a clip, or the cut at a clip's end. */
  lands: "clip" | "cut";
  family: EffectFamily;
  /** The transition a cut item places (a drop on an edit spot and the default-transition keys use it). */
  transition?: TransitionSpec;
  /** Other words the search finds it by. */
  keywords: readonly string[];
  /** The edit it makes on the selection, or why it cannot; ids of new objects come from `allocate`. */
  plan: (selection: EffectSelection, allocate: AllocateId) => EffectPlan;
}

/** Frames of a fade the browser adds; the same length as a new transition. */
const FADE_FRAMES = DEFAULT_TRANSITION_FRAMES;
/** Impact frames a new impact replaces (action animation inserts one to three). */
const IMPACT_FRAMES = 2;
/** The push-in a new camera move starts with, in percent of the frame. */
const ZOOM_PERCENT = 115;
/** A new shake: its amplitude in sequence pixels, fading out over this many frames. */
const SHAKE_PX = 12;
const SHAKE_FRAMES = 12;

const NOTHING_SELECTED = t("先選取時間軸上的片段");
const TRANSITION_SELECTED = t("目前選取的是轉場；請選取要套用效果的片段");
const ALREADY_APPLIED = t("選取的片段已經有這個效果；在「效果控制」調整");

function unavailable(reason: string): EffectPlan {
  return { ok: false, reason, applied: false };
}

function alreadyApplied(reason: string): EffectPlan {
  return { ok: false, reason, applied: true };
}

function trackKind(timeline: StudioTimeline, clip: TimelineClip): "video" | "audio" | null {
  return timeline.tracks.find((track) => track.track_id === clip.track_id)?.kind ?? null;
}

/** The clip a picture effect lands on, or why the selection has none. */
function videoClip({ timeline, clip, transitionClip }: EffectSelection): TimelineClip | string {
  if (!clip) return transitionClip ? TRANSITION_SELECTED : NOTHING_SELECTED;
  return trackKind(timeline, clip) === "video" ? clip : t("視訊效果要套用在視訊軌的片段");
}

/** The sound a clip plays: the clip itself on an audio track, else its linked partner there. */
function soundOf(timeline: StudioTimeline, clip: TimelineClip): TimelineClip | null {
  if (trackKind(timeline, clip) === "audio") return clip;
  if (!clip.linked_id) return null;
  return timeline.clips.find((item) => item.linked_id === clip.linked_id && trackKind(timeline, item) === "audio") ?? null;
}

/** The clip a sound effect lands on, or why the selection has none. */
function audioClip({ timeline, clip, transitionClip }: EffectSelection): TimelineClip | string {
  if (!clip) return transitionClip ? TRANSITION_SELECTED : NOTHING_SELECTED;
  return soundOf(timeline, clip) ?? t("這個片段沒有連結音訊；請選取音軌上的片段");
}

function patchEffects(clip: TimelineClip, effects: MediaClipEffects, linked: boolean): EffectPlan {
  return { ok: true, clip, command: { type: "patchClip", clipId: clip.clip_id, linked, patch: { effects } } };
}

/**
 * A transition on the cut at the end of the selected clip (of its sound, for the sound's crossfade), or on the
 * selected transition. One that is already there keeps its length and changes its kind; a new one is as long as both
 * clips allow, up to the default length.
 */
function transitionItem(id: string, category: EffectCategoryId, icon: LucideIcon, keywords: readonly string[], spec: TransitionSpec): EffectItem {
  return {
    id,
    category,
    label: spec.label,
    icon,
    lands: "cut",
    family: "transition",
    transition: spec,
    keywords,
    plan: (selection) => {
      const selected = selection.transitionClip ?? selection.clip;
      if (!selected) return unavailable(t("先選取轉場前的片段"));
      const clip = spec.sound ? soundOf(selection.timeline, selected) : selected;
      if (!clip) return unavailable(t("這個片段沒有連結音訊；請選取音軌上的片段"));
      if (!spec.sound && trackKind(selection.timeline, clip) !== "video") return unavailable(t("視訊轉場要套用在視訊軌的片段"));
      const spot = clipEndSpots(selection.timeline, clip).tail;
      if (spot.kind !== "cut") return unavailable(t("這個片段後面沒有緊鄰的片段"));
      return planAtSpot(selection.timeline, spot, spec, selection.linked);
    },
  };
}

/** The icon of each transition kind in the browser. */
const TRANSITION_ICONS: Record<TransitionStyle, LucideIcon> = {
  crossfade: Hourglass,
  dip_to_black: Hourglass,
  dip_to_white: Hourglass,
  push: ArrowLeftRight,
  slide: PanelLeftOpen,
  whip: Wind,
  wipe: Blinds,
  zoom: Maximize2,
};

/** A picture transition; a moving one starts to the left (a zoom: in), changed in Effect Controls. */
function videoTransition(kind: TransitionStyle, keywords: readonly string[] = []): EffectItem {
  return transitionItem(`transition:${kind}`, "video-transitions", TRANSITION_ICONS[kind], keywords, { kind, sound: false, label: TRANSITION_LABELS[kind] });
}

const EFFECT_ICONS: Record<ClipEffect["kind"], LucideIcon> = {
  color: Palette,
  blur: Droplets,
  chroma_key: Pipette,
  glow: Sparkles,
  rgb_split: Layers,
  vignette: Aperture,
  grain: Film,
  directional_blur: MoveHorizontal,
  sharpen: Focus,
};

function stackEffect(kind: ClipEffect["kind"], keywords: readonly string[]): EffectItem {
  return {
    id: `stack:${kind}`,
    category: "video-effects",
    label: EFFECT_NAMES[kind],
    icon: EFFECT_ICONS[kind],
    lands: "clip",
    family: "stack",
    keywords,
    plan: (selection, allocate) => {
      const clip = videoClip(selection);
      if (typeof clip === "string") return unavailable(clip);
      const stack = clip.effect_stack ?? [];
      if (stack.length >= EFFECT_LIMIT) return unavailable(t("每個片段最多 {count} 個效果", { count: EFFECT_LIMIT }));
      const effect_stack = [...stack, newEffect(kind, allocate("fx"))];
      return { ok: true, clip, command: { type: "patchClip", clipId: clip.clip_id, linked: selection.linked, patch: { effect_stack } } };
    },
  };
}

interface ClipEffectSpec {
  id: string;
  label: string;
  icon: LucideIcon;
  keywords: readonly string[];
  /** "phase": it changes which frames the clip's effects fall on (impact frames, shake). */
  family: "patch" | "phase";
  /** Whether the clip already carries it. */
  present: (effects: MediaClipEffects, clip: TimelineClip) => boolean;
  /** The clip's effects with it added. */
  add: (effects: MediaClipEffects, clip: TimelineClip) => MediaClipEffects;
}

/** An effect that lives in the clip's own effects (colour, impact frames, camera): added once, adjusted in Effect Controls. */
function clipEffect(spec: ClipEffectSpec): EffectItem {
  return {
    id: spec.id,
    category: "video-effects",
    label: spec.label,
    icon: spec.icon,
    lands: "clip",
    family: spec.family,
    keywords: spec.keywords,
    plan: (selection) => {
      const clip = videoClip(selection);
      if (typeof clip === "string") return unavailable(clip);
      const effects = clip.effects ?? {};
      return spec.present(effects, clip) ? alreadyApplied(ALREADY_APPLIED) : patchEffects(clip, spec.add(effects, clip), selection.linked);
    },
  };
}

function impactEffect(style: ImpactStyle): EffectItem {
  return clipEffect({
    id: `impact:${style}`,
    label: t("衝擊格：{style}", { style: IMPACT_STYLE_LABELS[style] }),
    icon: Zap,
    keywords: [],
    family: "phase",
    present: (effects) => effects.impact?.style === style,
    // Another style on a clip that has impact frames keeps their count
    add: (effects, clip) => ({ ...effects, impact: { frames: effects.impact?.frames ?? Math.min(IMPACT_FRAMES, clipDuration(clip)), style } }),
  });
}

function fadeEffect(edge: FadeEdge, label: string, icon: LucideIcon): EffectItem {
  const sound = edge === "audio_in" || edge === "audio_out";
  return {
    id: `fade:${edge}`,
    category: sound ? "audio" : "video-effects",
    label,
    icon,
    lands: "clip",
    family: "phase",
    keywords: [t("淡化")],
    plan: (selection) => {
      const clip = sound ? audioClip(selection) : videoClip(selection);
      if (typeof clip === "string") return unavailable(clip);
      const effects = clip.effects ?? {};
      if ((effects.fade?.[edge] ?? 0) > 0) return alreadyApplied(ALREADY_APPLIED);
      const frames = Math.min(FADE_FRAMES, fadeRoom(clip, edge));
      if (frames < 1) return unavailable(t("片段太短，放不下淡化"));
      return patchEffects(clip, { ...effects, fade: { ...effects.fade, [edge]: frames } }, selection.linked);
    },
  };
}

// A transition takes the clip's linked partners along: on linked sound it is refused (the picture's cross dissolve
// crossfades the sound with it)
const audioCrossfade = transitionItem("transition:audio-crossfade", "audio", Blend, [t("轉場")], { kind: "crossfade", sound: true, label: AUDIO_CROSSFADE_LABEL });

export const EFFECT_ITEMS: readonly EffectItem[] = [
  videoTransition("crossfade"),
  videoTransition("dip_to_black"),
  videoTransition("dip_to_white"),
  videoTransition("push"),
  videoTransition("slide"),
  videoTransition("whip", [t("快速搖攝")]),
  videoTransition("wipe"),
  videoTransition("zoom"),
  stackEffect("color", [t("調色")]),
  stackEffect("blur", []),
  stackEffect("directional_blur", [t("動態模糊")]),
  stackEffect("sharpen", []),
  stackEffect("glow", [t("泛光")]),
  stackEffect("rgb_split", [t("色差")]),
  stackEffect("vignette", []),
  stackEffect("grain", [t("雜訊")]),
  stackEffect("chroma_key", []),
  // The names of the clip's own effects start with the group of Effect Controls that adjusts them afterwards
  clipEffect({
    id: "color:monochrome",
    label: t("調色：黑白"),
    icon: Contrast,
    keywords: [],
    family: "patch",
    present: (effects) => effects.color?.saturation === 0,
    add: (effects) => ({ ...effects, color: { ...effects.color, saturation: 0 } }),
  }),
  clipEffect({
    id: "color:negative",
    label: t("調色：負片"),
    icon: SunMoon,
    keywords: [],
    family: "patch",
    present: (effects) => effects.color?.invert === true,
    add: (effects) => ({ ...effects, color: { ...effects.color, invert: true } }),
  }),
  ...IMPACT_STYLES.map(impactEffect),
  clipEffect({
    id: "camera:zoom",
    label: t("鏡頭運動：推近"),
    icon: ZoomIn,
    keywords: [],
    family: "patch",
    present: (effects) => (effects.camera?.zoom_percent ?? 100) > 100,
    add: (effects) => ({ ...effects, camera: { ...effects.camera, zoom_percent: ZOOM_PERCENT } }),
  }),
  clipEffect({
    id: "camera:shake",
    label: t("鏡頭運動：震動"),
    icon: Vibrate,
    keywords: [],
    family: "phase",
    present: (effects) => (effects.camera?.shake_px ?? 0) > 0 && (effects.camera?.shake_frames ?? 0) > 0,
    add: (effects, clip) => ({ ...effects, camera: { ...effects.camera, shake_px: SHAKE_PX, shake_frames: Math.min(SHAKE_FRAMES, clipDuration(clip)) } }),
  }),
  fadeEffect("video_in", t("視訊淡入"), Sunrise),
  fadeEffect("video_out", t("視訊淡出"), Sunset),
  audioCrossfade,
  fadeEffect("audio_in", t("音訊淡入"), Volume2),
  fadeEffect("audio_out", t("音訊淡出"), Volume1),
];

/** Whether an item's name, its category or one of its other words contains the query. */
export function matchesEffect(item: EffectItem, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase();
  if (wanted === "") return true;
  const category = EFFECT_CATEGORIES.find((entry) => entry.id === item.category)?.label ?? "";
  return [item.label, category, ...item.keywords].some((text) => text.toLocaleLowerCase().includes(wanted));
}

export interface EffectAvailability {
  /** Why the item cannot be applied to the selection; null when it can. */
  reason: string | null;
  /** The selection already carries it. */
  applied: boolean;
  /** The clip it would be applied to. */
  clipName: string | null;
}

const previewId: AllocateId = (prefix) => `${prefix}-preview`;

/**
 * Whether each item applies to the selection. Every plan is checked (cheap), but a command is run on a copy of the
 * timeline once per family and clip: the commands of one family on one clip are refused for the same reasons (see
 * EffectFamily), so each item still gets the answer and the message its own command would give.
 */
export function effectAvailabilities(items: readonly EffectItem[], selection: EffectSelection): Map<string, EffectAvailability> {
  const trials = new Map<string, string | null>();
  const out = new Map<string, EffectAvailability>();
  for (const item of items) {
    const plan = item.plan(selection, previewId);
    if (!plan.ok) {
      out.set(item.id, { reason: plan.reason, applied: plan.applied, clipName: null });
      continue;
    }
    const key = `${item.family}:${plan.clip.clip_id}`;
    let error = trials.get(key);
    if (error === undefined) {
      const result = executeEdit(selection.timeline, plan.command, previewId);
      error = result.ok ? null : result.error;
      trials.set(key, error);
    }
    out.set(item.id, error === null ? { reason: null, applied: false, clipName: plan.clip.name } : { reason: error, applied: false, clipName: null });
  }
  return out;
}

/** The item of an id (a drag carries the id). */
export function effectItem(id: string): EffectItem | null {
  return EFFECT_ITEMS.find((item) => item.id === id) ?? null;
}
