// The parts of a clip two panels edit: its basic colour correction (the Color group of Effect Controls and the Color
// dock) and its text (the Text group and the Text dock). What their fields offer and the clip each change produces.
// Pure.
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { COLOR_DEFAULTS, type Color, type Title, type TitlePosition, type TitleSize } from "../../../model/clipEffects";
import type { TitleStyle } from "../../../model/titleLayout";
import type { ChoiceOption } from "./fields";
import { UNITS, type Unit } from "./properties";

// ---------------------------------------------------------------------------------------------------- colour

export interface ColorValue {
  key: "brightness" | "contrast" | "saturation";
  label: string;
  /** What the unchanged value is, for the tooltip. */
  hint: string;
  unit: Unit;
  min: number;
  max: number;
}

/** The numeric values of the basic colour correction, in the order the panels list them (bounds of the document). */
export const COLOR_VALUES: readonly ColorValue[] = [
  { key: "brightness", label: t("亮度"), hint: t("0 是原本的亮度"), unit: UNITS.balance, min: -1, max: 1 },
  { key: "contrast", label: t("對比"), hint: t("100 % 是原本的對比"), unit: UNITS.wholePercent, min: 0, max: 3 },
  { key: "saturation", label: t("飽和度"), hint: t("100 % 是原本的飽和度，0 % 是黑白"), unit: UNITS.wholePercent, min: 0, max: 3 },
];

export function colorValue(clip: TimelineClip, key: ColorValue["key"]): number {
  return clip.effects?.color?.[key] ?? COLOR_DEFAULTS[key];
}

export function withColor(clip: TimelineClip, change: Color): TimelineClip {
  return { ...clip, effects: { ...clip.effects, color: { ...clip.effects?.color, ...change } } };
}

export function withColorValue(clip: TimelineClip, key: ColorValue["key"], value: number): TimelineClip {
  const change: Color = {};
  change[key] = value;
  return withColor(clip, change);
}

/** Whether the clip's colour differs from the picture as it is. */
export function colorChanged(clip: TimelineClip): boolean {
  return COLOR_VALUES.some((value) => colorValue(clip, value.key) !== COLOR_DEFAULTS[value.key]) || clip.effects?.color?.invert === true;
}

export function withoutColor(clip: TimelineClip): TimelineClip {
  const { color: _color, ...effects } = clip.effects ?? {};
  return { ...clip, effects };
}

// ---------------------------------------------------------------------------------------------------- text

export const TITLE_POSITIONS: readonly ChoiceOption<TitlePosition>[] = [
  { value: "top", label: t("上方置中") },
  { value: "center", label: t("正中央") },
  { value: "bottom", label: t("下方置中") },
  { value: "lower_third", label: t("左下三分之一") },
];

export const TITLE_SIZES: readonly ChoiceOption<TitleSize>[] = [
  { value: "small", label: t("小") },
  { value: "medium", label: t("中") },
  { value: "large", label: t("大") },
];

export const TITLE_FONTS: readonly ChoiceOption<TitleStyle["font_family"]>[] = [
  { value: "sans", label: t("黑體") },
  { value: "serif", label: t("明體") },
  { value: "mono", label: t("等寬字型") },
];

export type TitleWeight = "regular" | "bold";

export const TITLE_WEIGHTS: readonly ChoiceOption<TitleWeight>[] = [
  { value: "regular", label: t("標準") },
  { value: "bold", label: t("粗體") },
];

/** Bounds of the font size, in pixels of a 1080-line frame (the document's). */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 300;

/** The text a clip gets when one is added to it. */
export function newTitle(): Title {
  return { text: t("新標題"), position: "center", size: "medium", start_frame: 0, end_frame: null, image: null, image_key: null };
}

/** The clip with another text. The layer drawn from the old text no longer fits, so it is dropped and drawn again for the export. */
export function withTitle(clip: TimelineClip, title: Title): TimelineClip {
  return { ...clip, effects: { ...clip.effects, title: { ...title, image: null, image_key: null } } };
}

export function withoutTitle(clip: TimelineClip): TimelineClip {
  const { title: _title, ...effects } = clip.effects ?? {};
  return { ...clip, effects };
}

/** The text back on its preset layout (a position and a size instead of its own font, colour and place). */
export function withoutTitleStyle(title: Title): Title {
  const { style: _style, ...preset } = title;
  return preset;
}
