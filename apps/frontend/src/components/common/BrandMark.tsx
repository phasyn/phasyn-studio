import { cn } from "@/lib/cn";

/**
 * Phasyn 的玻璃層疊「P」標誌（透明背景版縮成 64／128／256 px WebP，放在 public/brand/；來源）。
 * 只用在深色介面的品牌位置：側欄頂端、啟動／讀取畫面、空狀態、關於。淺色或未知背景（favicon、PWA 圖示、分享圖）
 * 用帶深色圓角底的 icon-*.png。預設是裝飾（alt=""、aria-hidden）；給 label 時才是有名稱的圖片。
 */
const MARK_64 = "/brand/mark-64.webp";
const MARK_128 = "/brand/mark-128.webp";
const MARK_256 = "/brand/mark-256.webp";

export interface BrandMarkProps {
  /** 顯示尺寸（CSS px，正方形；標誌本身佔高度約 92%）。 */
  size?: number;
  /** 品牌光暈（drop-shadow）：側欄、啟動畫面、空狀態等品牌時刻；密集資料區不要用。 */
  glow?: boolean;
  /** 讀取中的呼吸效果（只改透明度）。 */
  breathing?: boolean;
  /** 無障礙名稱；不給時是裝飾。 */
  label?: string;
  className?: string;
}

export function BrandMark({ size = 32, glow = false, breathing = false, label, className }: BrandMarkProps) {
  const src = size <= 32 ? MARK_64 : size <= 64 ? MARK_128 : MARK_256;
  return (
    <img
      src={src}
      srcSet={`${MARK_64} 64w, ${MARK_128} 128w, ${MARK_256} 256w`}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      decoding="async"
      className={cn(
        "shrink-0 object-contain select-none",
        glow && "drop-shadow-[0_0_14px_rgb(79_123_255_/_0.45)]",
        breathing && "brand-breathe",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
