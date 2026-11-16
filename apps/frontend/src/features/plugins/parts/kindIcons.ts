// 貢獻種類的圖示與顏色（顏色只標示種類，不標示狀態）：限制＝盾牌（品牌青）、風格＝調色盤（紫）、效果＝星芒（藍）、
// 生成設定＝滑桿（青綠）。
import { Palette, ShieldCheck, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import type { ContributionKind } from "../model/contributions";

export const KIND_ICON: Record<ContributionKind, LucideIcon> = {
  constraint: ShieldCheck,
  style: Palette,
  effect: Sparkles,
  generation: SlidersHorizontal,
};

export const KIND_TONE: Record<ContributionKind, string> = {
  constraint: "text-brand-cyan",
  style: "text-entity",
  effect: "text-action-fg",
  generation: "text-file",
};
