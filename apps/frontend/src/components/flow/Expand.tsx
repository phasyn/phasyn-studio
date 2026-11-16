// 可展開的區塊（面板以 grid-template-rows 0fr → 1fr 展開，smooth 彈簧）。內容一直在 DOM 裡（才能過場），
// 收合時是 inert＋aria-hidden：不能聚焦、輔助技術讀不到，狀態立即生效、不等動畫。
// 觸發的按鈕仍由呼叫端提供 aria-expanded／aria-controls（指向這裡的 id）。
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Expand({ id, open, children, className, innerClassName }: { id?: string; open: boolean; children: ReactNode; className?: string; innerClassName?: string }) {
  return (
    <div
      id={id}
      inert={!open}
      aria-hidden={open ? undefined : true}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--duration-spring-smooth) ease-(--ease-spring-smooth)",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
    >
      <div className={cn("min-h-0 overflow-hidden", innerClassName)}>{children}</div>
    </div>
  );
}
