// 素材庫清單與詳細資料共用的小元件：使用數標記、渲染成品的縮圖（影片第一格）與「使用中」標記。
import { CircleCheck, ImageOff, Link2 } from "lucide-react";
import { useState } from "react";
import { mediaUrl } from "@/api/http";
import { cn } from "@/lib/cn";
import type { RenderEntry } from "../../model/library";
import { t } from "@/i18n";

export function UseBadge({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span title={t("{count} 處使用", { count })} className={cn("inline-flex items-center gap-0.5", className)}>
      <Link2 aria-hidden className="size-3" />
      <span className="machine">{count}</span>
    </span>
  );
}

/** 成品影片的第一格（讀不到檔案時顯示圖示，不放假畫面）。 */
export function RenderThumb({ entry, className }: { entry: RenderEntry; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ImageOff aria-hidden className="size-4 text-fg-disabled" />;
  const file = entry.asset.file;
  return <video src={`${mediaUrl(file.node_id, file.file_id)}#t=0.1`} preload="metadata" muted playsInline aria-hidden onError={() => setFailed(true)} className={cn("size-full object-cover", className)} />;
}

/** 「使用中」標記（鏡頭的時間軸與匯出用這個 take）。 */
export function ActiveMark({ className }: { className?: string }) {
  return (
    <span title={t("時間軸與匯出用這個 take")} className={cn("inline-flex items-center gap-1 text-brand-cyan", className)}>
      <CircleCheck aria-hidden className="size-3" />
      {t("使用中")}
    </span>
  );
}
