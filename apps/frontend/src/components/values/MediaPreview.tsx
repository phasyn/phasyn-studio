import { AssetAudio, AssetVideo } from "@/components/common/AssetMedia";
import { AudioLines, FileQuestion, ImageOff } from "lucide-react";
import { useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function majorOf(file: FileRef): string {
  return ((file.media_type.split(";")[0] ?? "").trim().toLowerCase().split("/")[0] ?? "") || "";
}

/**
 * 上傳後的預覽：直接讀主控上的檔（/api/media，Range），object-fit: contain 不裁切；
 * size="thumb" 是清單用的小縮圖（影片顯示 0.1 秒處的畫面、不播放），size="player" 有播放控制。
 */
export function MediaPreview({ file, title, size = "player", className }: { file: FileRef; title: string; size?: "thumb" | "player"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(file.node_id, file.file_id);
  const major = majorOf(file);
  const thumb = size === "thumb";
  const frame = cn(
    "rounded-lg border border-line-subtle bg-stage object-contain",
    thumb ? "h-14 w-24 shrink-0" : "max-h-72 w-full",
    className,
  );
  if (failed) {
    return (
      <div className={cn(frame, "grid place-items-center gap-1 p-2 text-center text-caption text-fg-tertiary")} role="img" aria-label={t("{title}：無法預覽", { title })}>
        <ImageOff aria-hidden className="size-4" />
        {thumb ? null : <span>{t("無法在瀏覽器預覽：檔案可能不存在、持有者離線或格式不支援。")}</span>}
      </div>
    );
  }
  if (major === "image") return <img src={url} alt={title} loading="lazy" onError={() => { setFailed(true); }} className={frame} />;
  if (major === "video") {
    return thumb ? (
      <AssetVideo src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-label={title} onError={() => { setFailed(true); }} className={frame} />
    ) : (
      <AssetVideo src={url} controls preload="metadata" aria-label={title} onError={() => { setFailed(true); }} className={frame} />
    );
  }
  if (major === "audio") {
    return thumb ? (
      <div className={cn(frame, "grid place-items-center text-file")} role="img" aria-label={title}>
        <AudioLines aria-hidden className="size-5" />
      </div>
    ) : (
      <AssetAudio src={url} controls preload="metadata" aria-label={title} onError={() => { setFailed(true); }} className={cn("w-full", className)} />
    );
  }
  return (
    <div className={cn(frame, "grid place-items-center gap-1 p-2 text-center text-caption text-fg-tertiary")} role="img" aria-label={t("{title}：{value}，無法預覽", { title, value: file.media_type || t("未知類型") })}>
      <FileQuestion aria-hidden className="size-4" />
      {thumb ? null : (
        <span>
          <T source={"{code} 無法在瀏覽器預覽。"} values={{ code: <code className="machine">{file.media_type || t("未知類型")}</code> }} />
        </span>
      )}
    </div>
  );
}
