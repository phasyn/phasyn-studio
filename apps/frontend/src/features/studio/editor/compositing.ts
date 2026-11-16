import type { TimelineClip } from "@/api/generated/contracts";
import { EFFECT_BOUNDS } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { compositingChannels } from "./animation";
import { curveProblem } from "./curves";
import { processedDuration } from "./model";

export type ClipEffect = NonNullable<TimelineClip["effect_stack"]>[number];
export type ClipMask = NonNullable<TimelineClip["mask"]>;
export const EFFECT_LIMIT = 8;
export const EFFECT_NAMES: Record<ClipEffect["kind"], string> = {
  color: t("色彩校正"), blur: t("高斯模糊"), chroma_key: t("色度去背"),
  glow: t("光暈"), rgb_split: t("RGB 分離"), vignette: t("暗角"), grain: t("底片顆粒"), directional_blur: t("方向模糊"), sharpen: t("銳利化"),
};
export const BLEND_NAMES = { normal: t("正常"), multiply: t("色彩增值"), screen: t("濾色"), add: t("相加") } as const;
export function newEffect(kind: ClipEffect["kind"], effectId: string): ClipEffect {
  const common = { effect_id: effectId, enabled: true };
  switch (kind) {
    case "color": return { ...common, kind, brightness: 0, contrast: 1, saturation: 1 };
    case "blur": return { ...common, kind, radius: 4 };
    case "chroma_key": return { ...common, kind, color: "#00ff00", similarity: 0.15, blend: 0.1 };
    case "glow": return { ...common, kind, intensity: 1, radius: 16, threshold: 0.6 };
    case "rgb_split": return { ...common, kind, offset: 6, angle: 0 };
    case "vignette": return { ...common, kind, amount: 0.5, softness: 0.5 };
    case "grain": return { ...common, kind, amount: 0.2 };
    case "directional_blur": return { ...common, kind, length: 24, angle: 0 };
    case "sharpen": return { ...common, kind, amount: 1 };
  }
}
export function defaultMask(kind: ClipMask["kind"]): ClipMask {
  return { kind, x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0, invert: false };
}
const bounded = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/** Whether every numeric parameter of an effect lies in the contract's bounds (the look effects have no others). */
function parametersInBounds(effect: ClipEffect): boolean {
  const values: Partial<Record<string, unknown>> = effect;
  return Object.entries<readonly [number, number]>(EFFECT_BOUNDS[effect.kind]).every(([name, [low, high]]) => {
    const value = values[name];
    return typeof value === "number" && bounded(value, low, high);
  });
}
export function compositingProblem(clip: TimelineClip): string | null {
  const effects = clip.effect_stack ?? [];
  if (effects.length > EFFECT_LIMIT || new Set(effects.map((item) => item.effect_id)).size !== effects.length) return t("效果堆疊最多 8 個效果，識別碼不得重複");
  for (const item of effects) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(item.effect_id) || typeof item.enabled !== "boolean") return t("效果識別碼或啟用狀態無效");
    if (item.kind === "color" && (!bounded(item.brightness, -1, 1) || !bounded(item.contrast, 0, 4) || !bounded(item.saturation, 0, 4))) return t("色彩效果參數超出允許範圍");
    if (item.kind === "blur" && !bounded(item.radius, 0, 64)) return t("模糊半徑必須介於 0–64 像素");
    if (item.kind === "chroma_key" && (!/^#[0-9a-f]{6}$/i.test(item.color) || !bounded(item.similarity, 0.01, 1) || !bounded(item.blend, 0, 1))) return t("色度去背參數無效");
    if (!parametersInBounds(item)) return t("「{name}」的參數超出允許範圍", { name: EFFECT_NAMES[item.kind] });
  }
  const mask = clip.mask;
  if (mask && (!bounded(mask.x, 0, 1) || !bounded(mask.y, 0, 1) || !bounded(mask.width, Number.EPSILON, 1) || !bounded(mask.height, Number.EPSILON, 1) || mask.x + mask.width > 1 + 1e-9 || mask.y + mask.height > 1 + 1e-9 || !bounded(mask.feather, 0, 0.5))) return t("遮罩範圍必須位於畫面內");
  if (compositingChannels(clip).some((channel) => curveProblem(channel.keys, processedDuration(clip), channel.min, channel.max))) return t("關鍵影格必須依時間排列、不重複且位於片段範圍內");
  return null;
}
