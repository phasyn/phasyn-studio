// 渲染成品（take 與序列匯出）在素材庫中央清單的內容（LibraryCollection 的 adapter）：磚＝影片第一格、take 編號或「匯出」、
// 使用中標記與長度；清單欄位＝名稱、鏡頭（take）、seed（take）、解析度、長度、大小、建立時間。
import { Clapperboard, Film } from "lucide-react";
import { HUD_CHIP, THUMB_ZOOM } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { renderEntryName, type RenderEntry } from "../../model/library";
import { renderDimensions, renderDuration, renderSize } from "./display";
import { ActiveMark, RenderThumb } from "./cardParts";
import type { CollectionAdapter, CollectionColumn } from "./LibraryCollection";
import { t } from "@/i18n";

const shotLabel = (entry: Extract<RenderEntry, { kind: "take" }>) => `${String(entry.shotIndex + 1).padStart(2, "0")} ${entry.shot.title}`;

function renderColumns(section: RenderEntry["kind"], width: number): CollectionColumn[] {
  const columns: CollectionColumn[] = [{ id: "name", label: t("名稱"), width: "minmax(14rem,2.4fr)", sort: "name" }];
  if (section === "take") {
    if (width >= 820) columns.push({ id: "shot", label: t("鏡頭"), width: "minmax(8rem,1.4fr)" });
    columns.push({ id: "active", label: t("使用中"), width: "5.5rem" }, { id: "seed", label: "seed", width: "7rem", align: "end" });
  }
  columns.push(
    { id: "dimensions", label: t("解析度"), width: "6.5rem" },
    { id: "duration", label: t("長度"), width: "5.5rem", sort: "duration", align: "end" },
    { id: "size", label: t("大小"), width: "6rem", sort: "size", align: "end" },
  );
  if (width >= 1000) columns.push({ id: "created", label: t("建立時間"), width: "9.5rem", sort: "created" });
  return columns;
}

/** section＝目前列出的種類（take 與匯出的欄位不同）。 */
export function renderAdapter(section: RenderEntry["kind"]): CollectionAdapter<RenderEntry> {
  return {
    idOf: (entry) => entry.id,
    titleOf: renderEntryName,
    columns: (width) => renderColumns(section, width),
    cell(entry, columnId) {
      switch (columnId) {
        case "name":
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid h-8 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
                <RenderThumb entry={entry} />
              </span>
              <span className="truncate text-data text-fg">{renderEntryName(entry)}</span>
            </span>
          );
        case "shot":
          return entry.kind === "take" ? <span className="truncate">{shotLabel(entry)}</span> : null;
        case "active":
          return entry.kind === "take" && entry.active ? <ActiveMark /> : <span className="text-fg-disabled">—</span>;
        case "seed":
          return entry.kind === "take" ? <span className="machine">{entry.take.seed}</span> : null;
        case "dimensions":
          return <span className="machine">{renderDimensions(entry)}</span>;
        case "duration":
          return <span className="machine">{renderDuration(entry)}</span>;
        case "size":
          return <span className="machine">{renderSize(entry)}</span>;
        case "created":
          return <span className="machine truncate">{formatTimestamp(entry.createdAt)}</span>;
        default:
          return null;
      }
    },
    tile(entry, thumbHeight) {
      return (
        <>
          <span className="relative grid place-items-center overflow-hidden rounded-lg border border-line-subtle bg-stage" style={{ height: thumbHeight }}>
            <RenderThumb entry={entry} className={THUMB_ZOOM} />
            <span className={cn(HUD_CHIP, "absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 text-[11px]")}>
              {entry.kind === "take" ? <Clapperboard aria-hidden className="size-3" /> : <Film aria-hidden className="size-3" />}
              {entry.kind === "take" ? `take ${entry.takeNumber}` : t("匯出")}
            </span>
            {entry.kind === "take" && entry.active ? <ActiveMark className={cn(HUD_CHIP, "absolute top-1.5 right-1.5 px-1.5 text-[11px]")} /> : null}
            <span className={cn(HUD_CHIP, "machine absolute right-1.5 bottom-1.5 px-1.5 text-[11px]")}>{renderDuration(entry)}</span>
          </span>
          <span className="truncate px-0.5 text-caption text-fg">{entry.kind === "take" ? shotLabel(entry) : renderEntryName(entry)}</span>
          <span className="machine truncate px-0.5 text-[11px] leading-4 text-fg-tertiary">
            {entry.kind === "take" ? `seed ${entry.take.seed} · ${renderDimensions(entry)} · ${renderSize(entry)}` : `${renderDimensions(entry)} · ${renderSize(entry)}`}
          </span>
        </>
      );
    },
  };
}
