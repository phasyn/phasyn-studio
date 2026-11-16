// 工具列上的 32 px 圖示開關（收合篩選、收合詳情、排序方向）。
import type { ReactNode } from "react";
import { TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { cn } from "@/lib/cn";

export function ToolToggle({ pressed, label, onClick, children }: { pressed: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} aria-label={label} title={label} onClick={onClick} className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", pressed && TOOL_BUTTON_ON)}>
      {children}
    </button>
  );
}
