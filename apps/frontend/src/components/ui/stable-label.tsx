import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * 選取時改成粗體也不改變寬度的標籤：隱藏的粗體副本（aria-hidden）撐出寬度，可見文字置中疊在同一格。
 * 用在分頁上，切換分頁時其他分頁不會左右跳動。不適合需要截斷（truncate）的長標籤。
 */
export function StableLabel({ children, weight = "semibold", className }: { children: ReactNode; weight?: "medium" | "semibold"; className?: string }) {
  return (
    <span className={cn("inline-grid justify-items-center", className)}>
      <span className="[grid-area:1/1]">{children}</span>
      <span aria-hidden className={cn("invisible [grid-area:1/1]", weight === "medium" ? "font-medium" : "font-semibold")}>
        {children}
      </span>
    </span>
  );
}
