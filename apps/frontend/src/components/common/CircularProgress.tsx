import { useId } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/**
 * macOS 式的圓形進度（只用在有真實比例時：已完成步數／總步數、已上傳位元組等；沒有證據就不要畫）。
 * 軌道是細的 line-strong，進度弧是亮色品牌漸層（自帶 gradient，不依賴外部 defs），數值改變時弧線線性前進（不彈簧）。
 * role="progressbar"＋aria-valuenow（0–100）；label 是無障礙名稱（例如「DiT 去噪進度」；沒給時是「進度」）。
 */
export function CircularProgress({
  value,
  size = 20,
  strokeWidth = 2.5,
  label = t("進度"),
  showValue = false,
  className,
}: {
  /** 0–1。 */
  value: number;
  /** 直徑（px）。 */
  size?: number;
  /** 弧線粗細（以 24 為邊長的座標）。 */
  strokeWidth?: number;
  label?: string;
  /** 在圓心顯示百分比（size ≥ 36 時才清楚）。 */
  showValue?: boolean;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const percent = Math.round(fraction * 100);
  const radius = 12 - strokeWidth / 2 - 0.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden focusable="false" className="-rotate-90">
        <defs>
          <linearGradient id={`cp-${id}`} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: "var(--color-brand-cyan)" }} />
            <stop offset="0.36" style={{ stopColor: "var(--color-brand-blue)" }} />
            <stop offset="0.68" style={{ stopColor: "var(--color-brand-iris)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-brand-violet)" }} />
          </linearGradient>
        </defs>
        <circle cx="12" cy="12" r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-line-strong" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          stroke={`url(#cp-${id})`}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className="transition-[stroke-dashoffset] duration-200 ease-linear"
        />
      </svg>
      {showValue ? <span className="machine absolute text-[10px] leading-none text-fg-secondary">{percent}</span> : null}
    </span>
  );
}
