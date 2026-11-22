// What the selected run produces, in the overview: one 280 px card per item (ItemCard; a finished one shows up as soon
// as its branch ends, the others keep rendering), or the exported video of a sequence export.
import { AssetVideo } from "@/components/common/AssetMedia";
import { Download } from "lucide-react";
import { mediaUrl } from "@/api/http";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { buttonVariants } from "@/components/ui/variants";
import { RISE_IN } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { formatDuration } from "../../model/frames";
import type { QueueItem } from "../../model/renderQueue";
import { useStudio } from "../../studioContext";
import { ItemCard } from "./ItemCard";
import type { RunItem } from "./runView";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";

function ExportOutput({ item, running }: { item: QueueItem; running: boolean }) {
  const { project } = useStudio();
  const asset = item.record?.asset;
  const file = asset?.file;
  if (!file) {
    if (!running) return null;
    return (
      <GeneratingFrame active className="max-w-xl rounded-lg">
        <div role="status" className="grid aspect-video w-full place-items-center rounded-lg bg-stage text-data text-fg-secondary">
          {t("匯出中…")}
        </div>
      </GeneratingFrame>
    );
  }
  const url = mediaUrl(file.node_id, file.file_id);
  const facts = joinInline([
    asset.width && asset.height ? t("{width}×{height}", { width: asset.width, height: asset.height }) : "",
    (item.record?.frames != null && Boolean(item.record.frames)) ? formatDuration(item.record.frames, project.format.fps.num / project.format.fps.den) : "",
    formatBytes(file.size_bytes),
  ].filter(Boolean));
  return (
    <div className={cn("grid max-w-4xl min-w-0 gap-2", RISE_IN)}>
      <AssetVideo src={url} controls preload="metadata" aria-label={t("序列匯出")} className="max-h-[52vh] w-full rounded-lg border border-line-subtle bg-stage object-contain" />
      <div className="flex flex-wrap items-center gap-3">
        <a href={url} download={`${project.title}.mp4`} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "no-underline")}>
          <Download aria-hidden />
          {t("下載 MP4")}
        </a>
        <span className="machine text-caption text-fg-tertiary">{facts}</span>
      </div>
    </div>
  );
}

export function Outputs({ item, items, running }: { item: QueueItem; items: readonly RunItem[]; running: boolean }) {
  if (item.kind === "export") return <ExportOutput item={item} running={running} />;
  if (items.length === 0) return null;
  return (
    <ul aria-label={item.kind === "variations" ? t("變體輸出") : t("鏡頭輸出")} className="grid grid-cols-[repeat(auto-fill,17.5rem)] gap-3">
      {items.map((entry, index) => (
        <ItemCard key={entry.take?.take_id ?? entry.suffix} item={item} entry={entry} index={index} showLeft={items.length > 1} />
      ))}
    </ul>
  );
}
