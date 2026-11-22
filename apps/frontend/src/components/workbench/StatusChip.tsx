import { LoaderCircle } from "lucide-react";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { CHIP_TONE, type Tone } from "./tones";

/**
 * 狀態 chip：點＋文字（進行中改用旋轉圖示）；顏色只是第二線索，文字永遠存在。
 * 狀態改變（例如「載入中→就緒」）時色調以 --duration-base 過渡、圖示與文字短暫淡入，不會硬切；第一次出現不播放。
 */
export function StatusChip({
  tone,
  label,
  spinning = false,
  title,
  className,
}: {
  tone: Tone;
  label: string;
  spinning?: boolean;
  title?: string;
  className?: string;
}) {
  const fade = useChangeFade<HTMLSpanElement>(`${tone}:${label}:${String(spinning ? 1 : 0)}`);
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-px text-caption font-medium whitespace-nowrap",
        "transition-[color,background-color,border-color] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)",
        CHIP_TONE[tone],
        className,
      )}
    >
      <span ref={fade} className="inline-flex min-w-0 items-center gap-1.5">
        {spinning ? (
          <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin" />
        ) : (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
        )}
        <span className="truncate">{label}</span>
      </span>
    </span>
  );
}
