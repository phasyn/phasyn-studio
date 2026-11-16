import { AuroraBackdrop } from "@/components/common/AuroraBackdrop";
import { BrandMark } from "@/components/common/BrandMark";
import { cn } from "@/lib/cn";

/**
 * 讀取中的品牌狀態（換工作區、lazy 頁面還沒載好）：極光背景（three.js）上的 Phasyn 標誌呼吸＋一行文字（role="status"）。
 * 讀取通常很快，所以 160 ms 後才淡入，避免一閃而過。
 */
export function BrandLoading({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" className={cn("relative isolate grid h-full min-h-40 place-items-center overflow-hidden p-6", className)}>
      <AuroraBackdrop className="animate-[fade-in_var(--duration-base)_var(--ease-enter)_160ms_both]" />
      <span className="grid justify-items-center gap-3 text-data text-fg-secondary animate-[fade-in_var(--duration-base)_var(--ease-enter)_160ms_both]">
        <BrandMark size={40} glow breathing />
        {label}
      </span>
    </div>
  );
}
