import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * 原生 details／summary：鍵盤（Enter／Space）可展開，內容不會在收合時留在 Tab 順序。箭頭以 snappy 彈簧旋轉；
 * 支援 ::details-content 的瀏覽器以 smooth 彈簧展開／收合高度（.disclosure，index.css），其他瀏覽器展開時內容淡入（reveal）。
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  return (
    <details open={defaultOpen || undefined} className={cn("disclosure min-w-0 [&[open]>div]:animate-reveal", className)}>
      <summary
        className={cn(
          "flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-sm text-data text-fg-secondary transition-colors duration-(--duration-fast) hover:text-fg [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) [[open]>summary>&]:rotate-90" />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className="mt-2 min-w-0">{children}</div>
    </details>
  );
}
