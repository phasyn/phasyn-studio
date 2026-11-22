// 進度條（Phasyn）：執行中＝品牌漸層＋移動高光（animate-shimmer）；完成＝success；失敗＝danger；未開始＝中性。
// 不知道比例時（例如還沒有步數）顯示「不確定進度」：整條淡漸層＋高光，沒有 aria-valuenow（不編數字）。
// 寬度改變以 --duration-base 線性過渡（進度不用彈簧），狀態不等動畫。
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export type ProgressTone = "running" | "done" | "failed" | "idle";

const FILL: Record<ProgressTone, string> = {
  running: "bg-brand-gradient animate-shimmer",
  done: "bg-success",
  failed: "bg-danger",
  idle: "bg-line-strong",
};

export function ProgressTrack({
  value,
  max = 1,
  tone,
  label,
  valueText,
  size = "md",
  className,
}: {
  /** 目前值；null＝不確定（只表示進行中，不顯示比例）。 */
  value: number | null;
  max?: number;
  tone: ProgressTone;
  /** 無障礙名稱（例如「DiT 去噪進度」）。 */
  label: string;
  /** 報讀的文字（例如「12／30 步」）。 */
  valueText?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const fraction = value === null || max <= 0 ? null : Math.min(1, Math.max(0, value / max));
  const track = cn("relative block overflow-hidden rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--color-line-subtle)]", size === "sm" ? "h-1" : "h-1.5", className);
  if (fraction === null) {
    return (
      <span role="progressbar" aria-label={label} aria-valuetext={valueText ?? (tone === "running" ? t("進行中") : undefined)} className={track}>
        <span aria-hidden className={cn("absolute inset-0 rounded-full", tone === "running" ? "bg-brand-gradient-soft animate-shimmer" : FILL[tone])} />
      </span>
    );
  }
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined} aria-valuetext={valueText} className={track}>
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--duration-base) ease-standard", FILL[tone])}
        style={{ width: `${String(fraction * 100)}%` }}
      />
    </span>
  );
}
