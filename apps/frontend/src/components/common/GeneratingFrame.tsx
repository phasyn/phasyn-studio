import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * 生成中的預覽框（監看器、中間預覽、take 縮圖）：active 時加上 1 px 品牌漸層光邊（畫在內容之上，滿版的影像也不會蓋住）
 * 與慢速光暈呼吸（animate-glow-pulse）。不改變版面與內容；結束時立即回到一般外框
 * （狀態不等動畫）。progress 只在呼叫端有真實比例時傳入（0–1，例如已完成步數／總步數），框底畫一條品牌漸層進度線
 * 並掃過 shimmer；沒有證據的進度不要傳。生成狀態的文字（「渲染中…」）仍由呼叫端以 role="status" 提供。
 */
export interface GeneratingFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  active: boolean;
  /** 已知的進度比例（0–1）；沒有時不畫進度線。 */
  progress?: number | null;
  children: ReactNode;
}

export function GeneratingFrame({ active, progress, children, className, ...props }: GeneratingFrameProps) {
  const fraction = active && typeof progress === "number" && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null;
  return (
    <div
      data-generating={active || undefined}
      aria-busy={active || undefined}
      className={cn("relative rounded-lg", active && "shadow-glow-sm animate-glow-pulse", className)}
      {...props}
    >
      {children}
      {active ? <span aria-hidden className="brand-edge" /> : null}
      {fraction !== null ? (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-0.5 overflow-hidden rounded-b-[inherit] bg-line-subtle/60">
          <span
            className="absolute inset-y-0 left-0 bg-brand-gradient transition-[width] duration-(--duration-base) ease-standard animate-shimmer"
            style={{ width: `${fraction * 100}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
