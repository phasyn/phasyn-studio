import { cn } from "@/lib/cn";

/**
 * 讀取中的佔位（形狀接近即將出現的內容）：raised 底＋掃過的淡高光（animate-shimmer）。
 * 純裝飾（aria-hidden）：讀取狀態的文字（role="status"）由呼叫端提供。
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block h-4 animate-shimmer", className)} />;
}
