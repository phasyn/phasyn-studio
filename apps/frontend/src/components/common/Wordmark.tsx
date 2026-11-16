import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * Phasyn Studio 字標（概念板：寬幾何大寫 PHASYN，A 沒有橫槓、中間是一個品牌藍三角；下方是字距很寬的 STUDIO）。
 * 以內嵌 SVG 畫字形（不下載字型、在每台機器都一樣）；整個字標是一張有名稱的圖片（「Phasyn Studio」），
 * decorative 時隱藏（例如旁邊已經有同名連結）。tagline 是英文副標（AI-NATIVE FILMMAKING PLATFORM），一般文字。
 * 字標座標：PHASYN 字高 100、筆畫 16；STUDIO 字高 30、筆畫 6（y 130–160）；寬 681。
 */
export interface WordmarkProps {
  /** 字標寬度（px）；高度依比例。 */
  width?: number;
  /** 只顯示 PHASYN（不含 STUDIO），用在很窄的位置。 */
  short?: boolean;
  /** PHASYN 用品牌漸層填色（啟動畫面等品牌時刻）；預設是目前文字色。 */
  gradient?: boolean;
  /** 顯示英文副標。 */
  tagline?: boolean;
  /** 純裝飾（旁邊已有同名文字或連結名稱）。 */
  decorative?: boolean;
  className?: string;
}

const VIEW_W = 681;

export function Wordmark({ width = 160, short = false, gradient = false, tagline = false, decorative = false, className }: WordmarkProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `wm-grad-${uid}`;
  const clipId = `wm-clip-${uid}`;
  const viewH = short ? 100 : 160;
  const letterFill = gradient ? `url(#${gradientId})` : "currentColor";
  return (
    <span className={cn("inline-grid justify-items-start gap-[0.35em] leading-none text-fg", className)}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        width={width}
        height={(width * viewH) / VIEW_W}
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : "Phasyn Studio"}
        aria-hidden={decorative ? true : undefined}
        focusable="false"
        className="block overflow-visible"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2={VIEW_W} y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: "var(--color-brand-cyan)" }} />
            <stop offset="0.5" style={{ stopColor: "var(--color-brand-blue)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-brand-violet)" }} />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={VIEW_W} height="100" />
          </clipPath>
        </defs>
        {/* PHASYN：P、H、S、Y 是 16 單位的筆畫；A、N 是填色多邊形（尖頂與平腳）。 */}
        <g fill="none" stroke={letterFill} strokeWidth="16" strokeLinejoin="miter" clipPath={`url(#${clipId})`}>
          <path d="M8 100V8H54A27 27 0 0 1 54 62H8" />
          <path d="M117 0V100M193 0V100M117 50H193" />
          <path d="M445 8H381A20 20 0 0 0 361 28V30A20 20 0 0 0 381 50H417A20 20 0 0 1 437 70V72A20 20 0 0 1 417 92H353" />
          <path d="M467 -10L517 50L567 -10M517 50V100" />
        </g>
        <path fill={letterFill} d="M221 100L277 0L333 100H314.66L277 32.75L239.34 100Z" />
        <path fill={letterFill} d="M589 0H605V100H589ZM665 0H681V100H665ZM589 0H609L681 100H661Z" />
        <path style={{ fill: gradient ? "var(--color-fg)" : "var(--color-brand-blue)" }} d="M253 100L277 57L301 100Z" />
        {short ? null : (
          <g fill="none" stroke="currentColor" strokeWidth="6" opacity="0.88">
            <path d="M27 133H9A6 6 0 0 0 3 139A6 6 0 0 0 9 145H18A6 6 0 0 1 24 151A6 6 0 0 1 18 157H0" />
            <path d="M129 133H159M144 133V160" />
            <path d="M264 130V146.5A10.5 10.5 0 0 0 285 146.5V130" />
            <path d="M393.5 133H404.5A12 12 0 0 1 404.5 157H393.5Z" />
            <path d="M535.5 130V160" />
            <rect x="654" y="133" width="24" height="24" rx="12" />
          </g>
        )}
      </svg>
      {tagline ? (
        <span className="text-[10px] font-medium tracking-[0.42em] whitespace-nowrap text-fg-tertiary uppercase">AI-Native Filmmaking Platform</span>
      ) : null}
    </span>
  );
}
