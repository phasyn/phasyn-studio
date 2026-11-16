import { useCallback, useRef, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { useActiveIndicator, type IndicatorOptions } from "./motion";

// 水平指示線用品牌漸層（青→藍→鳶尾→紫，跟著 scaleX 拉伸）；左側直線改用由上而下的同一組漸層。位置以 snappy 彈簧滑動（index.css）。
const EDGE_CLASS = {
  bottom: "bottom-0 left-0 h-0.5 w-px origin-left rounded-full bg-brand-gradient",
  top: "top-0 left-0 h-0.5 w-px origin-left rounded-full bg-brand-gradient",
  left: "top-0 left-0 h-px w-0.5 origin-top rounded-full bg-[image:linear-gradient(180deg,var(--color-brand-cyan),var(--color-brand-blue)_36%,var(--color-brand-iris)_68%,var(--color-brand-violet))]",
} as const;

/**
 * 分頁／導覽的目前位置指示線（2 px、品牌漸層）：放在 position: relative 的 tablist（或導覽列）裡，
 * 依目前分頁的位置與長度以 transform 滑動。純裝飾（aria-hidden），選取狀態仍由
 * aria-selected／aria-current 表達。as="li" 用在 <ul> 內（清單只含 li）。
 */
export function ActiveIndicator({
  container,
  edge = "bottom",
  as: Tag = "span",
  className,
  ...options
}: Omit<IndicatorOptions, "axis"> & {
  container: RefObject<HTMLElement | null>;
  edge?: keyof typeof EDGE_CLASS;
  as?: "span" | "li";
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    ref.current = node;
  }, []);
  useActiveIndicator(container, ref, { ...options, axis: edge === "left" ? "y" : "x" });
  return (
    <Tag
      ref={attach}
      aria-hidden
      role={Tag === "li" ? "presentation" : undefined}
      data-tab-indicator=""
      className={cn("pointer-events-none absolute z-[1]", EDGE_CLASS[edge], className)}
    />
  );
}
