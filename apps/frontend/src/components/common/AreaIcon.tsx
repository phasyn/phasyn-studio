import { BrainCircuit, Clapperboard, History, Images, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { BrandImage } from "./BrandImage";

export type AreaIconName = "image" | "video" | "inference" | "components" | "records";

/** 各工作區的 lucide 後備圖示（與側欄導覽相同）。 */
const AREA_LUCIDE: Record<AreaIconName, LucideIcon> = {
  image: Images,
  video: Clapperboard,
  inference: BrainCircuit,
  components: SlidersHorizontal,
  records: History,
};

/**
 * 工作區的玻璃圖示（AI 生成的品牌圖 `/brand/areas/{area}.webp`，透明背景）：只用在 ≥ 28 px 的位置
 * （工作區標頭、空狀態、啟動圖塊）；更小時直接用 lucide。圖還沒有（或載入失敗）時顯示同一工作區的 lucide 圖示，
 * 放在淡淡的品牌漸層圓角磚裡。純裝飾（aria-hidden）；名稱由旁邊的文字提供。
 */
export function AreaIcon({ area, size = 32, className }: { area: AreaIconName; size?: number; className?: string }) {
  const Icon = AREA_LUCIDE[area];
  const tile = (
    <span
      className={cn(
        "grid size-full place-items-center border border-action/25 bg-brand-gradient-soft text-brand-cyan shadow-edge",
        size >= 48 ? "rounded-2xl" : "rounded-lg",
      )}
    >
      <Icon aria-hidden style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} />
    </span>
  );
  if (size < 28) {
    return (
      <span aria-hidden className={cn("inline-grid shrink-0", className)} style={{ width: size, height: size }}>
        <Icon aria-hidden className="size-full text-brand-cyan" />
      </span>
    );
  }
  return (
    <BrandImage src={`/brand/areas/${area}.webp`} srcSet={`/brand/areas/${area}@2x.webp 2x`} width={size} fallback={tile} {...(className === undefined ? {} : { className })} />
  );
}
