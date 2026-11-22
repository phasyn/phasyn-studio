// 圖片縮圖與畫面：透明區用棋盤格（靜態空間參考）顯示，也可以改成白底或黑場比較。讀不到時顯示圖示與原因，不放假畫面。
// 圖片讀完才淡入（opacity）；imgClassName 給呼叫端加縮圖的懸停放大（在裁切框內）。
import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { cn } from "@/lib/cn";
import { BACKDROP_CLASS, fileUrl, type Backdrop } from "./display";
import { t } from "@/i18n";

/** 小縮圖（清單、take 格子）：object-cover；讀取失敗時顯示圖示。 */
export function ImageThumb({
  file,
  alt = "",
  className,
  imgClassName,
  backdrop = "checker",
  fit = "cover",
}: {
  file: Pick<FileRef, "node_id" | "file_id"> | null | undefined;
  alt?: string;
  className?: string;
  imgClassName?: string;
  backdrop?: Backdrop;
  fit?: "cover" | "contain";
}) {
  const url = fileUrl(file);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const broken = url !== null && failed === url;
  return (
    <span className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded-sm border border-line-subtle", BACKDROP_CLASS[backdrop], className)}>
      {(url != null && url !== "") && !broken ? (
        <span className={cn("block size-full", imgClassName)}>
          <img
            src={url}
            alt={alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => { setLoaded(url); }}
            onError={() => { setFailed(url); }}
            data-loaded={loaded === url || undefined}
            className={cn("size-full opacity-0 transition-opacity duration-(--duration-base) ease-standard data-[loaded]:opacity-100", fit === "cover" ? "object-cover" : "object-contain")}
          />
        </span>
      ) : (
        <ImageOff aria-hidden className="size-4 text-fg-disabled" />
      )}
      {broken ? <span className="sr-only">{t("圖片讀取失敗")}</span> : null}
    </span>
  );
}
