import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type AssetStatus = "pending" | "ok" | "missing";

/** 這個分頁已知的品牌點陣圖狀態（同一張圖只試一次；不存在的圖不會每次掛載都再請求）。 */
const assetStatus = new Map<string, AssetStatus>();

/**
 * 品牌點陣圖（public/brand/… 的 WebP，由品牌工作產生）與它的後備：圖還沒載好或不存在時顯示 fallback（例如 lucide 圖示或
 * Phasyn 標誌），載入完成後淡入取代。純裝飾（alt=""）；名稱由呼叫端的文字或 aria-label 提供。
 * 版面尺寸固定（width × height），換圖不會跳動。
 */
export function BrandImage({
  src,
  srcSet,
  width,
  height = width,
  fallback,
  className,
  imageClassName,
}: {
  src: string;
  /** 高解析度版本（例如 `/brand/areas/video@2x.webp 2x`）；沒有就只用 src。 */
  srcSet?: string;
  width: number;
  height?: number;
  fallback: ReactNode;
  className?: string;
  imageClassName?: string;
}) {
  const [status, setStatus] = useState<AssetStatus>(() => assetStatus.get(src) ?? "pending");
  const [source, setSource] = useState(src);
  if (source !== src) {
    setSource(src);
    setStatus(assetStatus.get(src) ?? "pending");
  }
  const settle = (next: AssetStatus) => {
    assetStatus.set(src, next);
    setStatus(next);
  };
  return (
    <span aria-hidden className={cn("relative inline-grid shrink-0 place-items-center", className)} style={{ width, height }}>
      {status !== "ok" ? fallback : null}
      {status !== "missing" ? (
        <img
          src={src}
          srcSet={srcSet}
          alt=""
          width={width}
          height={height}
          draggable={false}
          decoding="async"
          onLoad={() => settle("ok")}
          onError={() => settle("missing")}
          className={cn(
            "absolute inset-0 size-full object-contain select-none transition-opacity duration-(--duration-base) ease-standard",
            status === "ok" ? "opacity-100" : "opacity-0",
            imageClassName,
          )}
        />
      ) : null}
    </span>
  );
}
