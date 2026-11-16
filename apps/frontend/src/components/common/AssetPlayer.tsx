import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { FileLinks } from "./FileRefView";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export type AssetLabel = "preview" | "final" | "video" | "audio" | "image" | "source" | "file";

const LABEL_TEXT: Record<AssetLabel, string> = {
  preview: t("草稿 preview"),
  final: t("正式 final"),
  video: t("影片"),
  audio: t("音訊"),
  image: t("影像"),
  source: t("來源"),
  file: t("檔案"),
};

/**
 * 媒體播放：<video>／<audio>／<img> 直接讀 /api/media（Range），object-fit: contain，不裁切畫面。
 * 下載檔名標示 preview／final 等用途。
 */
export function AssetPlayer({
  file,
  label,
  title,
  width,
  height,
  className,
  showDownload = true,
}: {
  file: FileRef;
  label: AssetLabel;
  title: string;
  width?: number | null;
  height?: number | null;
  className?: string;
  showDownload?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(file.node_id, file.file_id);
  const mediaType = (file.media_type.split(";")[0] ?? "").trim().toLowerCase();
  const aspect = width && height ? `${width} / ${height}` : undefined;
  let player: React.ReactNode;
  if (failed) {
    player = (
      <div className="grid min-h-32 place-items-center gap-2 rounded-md border border-line-subtle bg-sunken p-4 text-center text-caption text-fg-secondary">
        <ImageOff aria-hidden className="size-5 text-fg-tertiary" />
        {t("無法在瀏覽器播放：檔案可能不存在、持有的 Node 離線或格式不支援；可下載後檢查。")}
      </div>
    );
  } else if (mediaType.startsWith("video/")) {
    player = (
      <video
        controls
        preload="metadata"
        src={url}
        aria-label={title}
        onError={() => setFailed(true)}
        className="max-h-[60vh] w-full rounded-md border border-line-subtle bg-sunken object-contain"
        style={aspect ? { aspectRatio: aspect } : undefined}
      />
    );
  } else if (mediaType.startsWith("audio/")) {
    player = <audio controls preload="metadata" src={url} aria-label={title} onError={() => setFailed(true)} className="w-full" />;
  } else if (mediaType.startsWith("image/")) {
    player = (
      <img
        src={url}
        alt={title}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-[60vh] w-full rounded-md border border-line-subtle bg-sunken object-contain"
        style={aspect ? { aspectRatio: aspect } : undefined}
      />
    );
  } else {
    player = (
      <p className="rounded-md border border-line-subtle bg-sunken p-3 text-caption text-fg-secondary">
        <T source={"媒體型別 <0>{media_type}</0> 無法在瀏覽器預覽；請下載。"} values={{ media_type: file.media_type }} slots={[<code className="machine" />]} />
      </p>
    );
  }
  return (
    <figure className={cn("m-0 grid min-w-0 gap-2", className)}>
      {player}
      <figcaption className="flex flex-wrap items-center gap-2 text-caption text-fg-secondary">
        <Badge tone={label === "final" ? "success" : label === "preview" ? "info" : "neutral"}>{LABEL_TEXT[label]}</Badge>
        <span className="min-w-0">{title}</span>
        {showDownload ? <FileLinks file={file} downloadLabel={label} className="ml-auto" /> : null}
      </figcaption>
    </figure>
  );
}
