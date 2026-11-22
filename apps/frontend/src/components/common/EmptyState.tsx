import { hasSlotContent } from "@/lib/dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AuroraBackdrop } from "./AuroraBackdrop";
import { BrandImage } from "./BrandImage";
import { BrandMark } from "./BrandMark";

export type EmptyIllustration = "frames" | "timeline" | "drop" | "offline";

/**
 * 空狀態（沒有資料、尚未選取、找不到頁面、離線）：插圖／品牌標誌／圖示磚＋標題＋說明＋動作，進場以 smooth 彈簧上升
 * （animate-rise-in）。視覺優先序：
 *   illustration＝品牌工作產生的空狀態插圖（`/brand/illustrations/{name}.webp`，160–240 px；還沒有時顯示 Phasyn 標誌）；
 *   mark＝透明的 Phasyn 標誌（品牌時刻：歡迎、整頁空狀態）；
 *   icon＝lucide 圖示磚（一般面板內）。
 */
export interface EmptyStateProps {
  /** lucide 圖示（aria-hidden）；有 illustration 或 mark 時忽略。 */
  icon?: ReactNode;
  /** 用 Phasyn 標誌代替圖示。 */
  mark?: boolean;
  /** 品牌插圖：frames（沒有影格／素材）、timeline（序列是空的）、drop（拖放上傳）、offline（連不到主控或 Node）。 */
  illustration?: EmptyIllustration;
  title: ReactNode;
  /** 一兩句說明（純文字或行內元素）。 */
  description?: ReactNode;
  /** 主要／次要動作（按鈕或連結）。 */
  action?: ReactNode;
  /** compact：面板內的小型空狀態（較少留白、較小的圖）。 */
  size?: "default" | "compact";
  /** 說明之後的額外內容（例如清單）。 */
  children?: ReactNode;
  /** 代表整頁或工作區主區的空狀態（品牌時刻）：背後放 three.js 極光（AuroraBackdrop）。頁面裡的清單、面板的空狀態不要用。 */
  scene?: boolean;
  className?: string;
}

function GlowingMark({ size }: { size: number }) {
  return (
    <span className="relative grid place-items-center" style={{ width: size, height: size }}>
      <span className="absolute inset-0 rounded-full bg-[radial-gradient(closest-side,rgb(62_137_255_/_0.28),transparent)]" />
      <BrandMark size={Math.round(size * 0.72)} glow className="relative" />
    </span>
  );
}

export function EmptyState({ icon, mark = false, illustration, title, description, action, size = "default", children, scene = false, className }: EmptyStateProps) {
  const compact = size === "compact";
  let visual: ReactNode = null;
  if (illustration) {
    const art = compact ? 120 : 176;
    visual = (
      <BrandImage
        src={`/brand/illustrations/${illustration}.webp`}
        srcSet={`/brand/illustrations/${illustration}@2x.webp 2x`}
        width={art}
        fallback={<GlowingMark size={compact ? 56 : 80} />}
      />
    );
  } else if (mark) {
    visual = (
      <span aria-hidden>
        <GlowingMark size={compact ? 56 : 80} />
      </span>
    );
  } else if (hasSlotContent(icon)) {
    visual = (
      <span
        aria-hidden
        className={cn(
          "grid place-items-center rounded-2xl border border-line bg-sunken text-fg-tertiary shadow-edge",
          compact ? "size-10 [&_svg]:size-5" : "size-12 [&_svg]:size-6",
        )}
      >
        {icon}
      </span>
    );
  }
  return (
    <div
      className={cn(
        "grid justify-items-center text-center text-fg-secondary animate-rise-in",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-10",
        scene && "relative isolate mx-auto min-h-[min(60vh,32rem)] w-full max-w-4xl content-center overflow-hidden rounded-2xl",
        className,
      )}
    >
      {scene ? <AuroraBackdrop /> : null}
      {visual}
      <p className={cn("font-semibold text-fg", compact ? "text-body" : "text-section")}>{title}</p>
      {hasSlotContent(description) ? <div className="max-w-[46ch] text-data leading-6 text-fg-secondary">{description}</div> : null}
      {children}
      {hasSlotContent(action) ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
