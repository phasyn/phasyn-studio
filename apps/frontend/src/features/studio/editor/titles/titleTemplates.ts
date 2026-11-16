// Title templates: a text layer that arrives styled and animated, at the playhead, on a free video track above the
// picture. Each template sets the text's look with the style fields a text has (font, size, weight, colour, alignment
// and place) and puts its In and Out presets on it, half a second each; everything stays editable afterwards in the
// Text and Animation groups. Pure.
import { BookOpen, Clapperboard, Heading1, IdCard, PanelBottom, type LucideIcon } from "lucide-react";
import type { StudioTimeline } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { Title, TitlePosition, TitleSize } from "../../model/clipEffects";
import type { TitleStyle } from "../../model/titleLayout";
import type { AllocateId, TimelineResult } from "../model";
import { textLayerFrames, textLayerParts, titlePlacement, withTextLayer } from "../textLayer";
import { ANIMATION_SIDES, defaultAnimationFrames, MIN_ANIMATION_FRAMES, withTextAnimation, type FrameSize, type TextPresetId } from "./textAnimation";

export interface TitleTemplate {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The text it starts with: what belongs there. */
  text: string;
  /** The preset layout nearest to its look (what "restore the default layout" brings back). */
  position: TitlePosition;
  size: TitleSize;
  style: TitleStyle;
  /** How long the layer is. */
  seconds: number;
  in: TextPresetId;
  out: TextPresetId;
}

export const TITLE_TEMPLATES: readonly TitleTemplate[] = [
  {
    id: "headline",
    label: t("置中大標題"),
    icon: Heading1,
    text: t("主標題"),
    position: "center",
    size: "large",
    style: { font_family: "sans", font_size: 132, font_weight: 700, color: "#ffffff", align: "center", x: 0.5, y: 0.5 },
    seconds: 4,
    in: "shrink",
    out: "shrink",
  },
  {
    id: "lower-third",
    label: t("下三分之一標題"),
    icon: PanelBottom,
    text: t("人物姓名・職稱"),
    position: "lower_third",
    size: "medium",
    style: { font_family: "sans", font_size: 60, font_weight: 700, color: "#ffffff", align: "left", x: 0.07, y: 0.82 },
    seconds: 5,
    in: "slideLeft",
    out: "slideLeft",
  },
  {
    id: "chapter",
    label: t("章節卡"),
    icon: BookOpen,
    text: t("第一章"),
    position: "center",
    size: "large",
    style: { font_family: "serif", font_size: 96, font_weight: 700, color: "#ffffff", align: "center", x: 0.5, y: 0.5 },
    seconds: 3,
    in: "rise",
    out: "drop",
  },
  {
    id: "end-card",
    label: t("片尾卡"),
    icon: Clapperboard,
    text: t("感謝觀看"),
    position: "center",
    size: "large",
    style: { font_family: "sans", font_size: 104, font_weight: 700, color: "#ffffff", align: "center", x: 0.5, y: 0.46 },
    seconds: 5,
    in: "blur",
    out: "fade",
  },
  {
    id: "name-tag",
    label: t("角色名牌"),
    icon: IdCard,
    text: t("角色名稱"),
    position: "lower_third",
    size: "medium",
    style: { font_family: "sans", font_size: 72, font_weight: 700, color: "#ffd166", align: "left", x: 0.08, y: 0.7 },
    seconds: 3,
    in: "pop",
    out: "pop",
  },
];

/**
 * A title from a template at the playhead (`at`), as one document: its layer on the free video track above the
 * picture there (a new track on top when none is free), styled, with its In and Out animations (shorter on a layer too
 * short for half a second each; none on one too short for any).
 */
export function createTitleFromTemplate(
  timeline: StudioTimeline,
  at: number,
  template: TitleTemplate,
  frame: FrameSize,
  allocate: AllocateId,
): TimelineResult<{ timeline: StudioTimeline; clipId: string }> {
  const frames = textLayerFrames(timeline, at, template.seconds);
  const track = titlePlacement(timeline, at, frames, allocate);
  if (!track.ok) return track;
  const title: Title = { text: template.text, position: template.position, size: template.size, style: template.style, start_frame: 0, end_frame: null, image: null, image_key: null };
  const { source, clip } = textLayerParts(at, frames, title, track.value.track_id, frame, allocate);
  // Both animations and a frame between them
  const length = Math.min(defaultAnimationFrames(timeline.fps.num / timeline.fps.den), Math.floor((frames - 2) / 2));
  let animated = clip;
  if (length >= MIN_ANIMATION_FRAMES) {
    for (const side of ANIMATION_SIDES) {
      const result = withTextAnimation(animated, side, template[side], length, frame, allocate);
      if (!result.ok) return result;
      animated = result.value;
    }
  }
  return withTextLayer(timeline, source, animated, track.value);
}
