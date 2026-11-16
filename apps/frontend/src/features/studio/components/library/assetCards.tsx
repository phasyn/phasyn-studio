// 參考素材在素材庫中央清單的內容（LibraryCollection 的 adapter）：磚＝縮圖、類型、長度與使用數；清單欄位＝名稱、類型、
// 解析度、長度、大小、使用、備註、加入時間（中央區域窄的時候先收起備註，再收起加入時間；名稱欄至少 14rem）。
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { HUD_CHIP, THUMB_ZOOM } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { libraryUseCount, type LibraryUse } from "../../model/library";
import { KindIcon } from "../../references/KindIcon";
import { KIND_LABEL } from "../../references/materials";
import { LibraryThumb } from "../../references/ReferenceRow";
import { itemDimensions, itemDuration, itemSize } from "./display";
import { UseBadge } from "./cardParts";
import type { CollectionAdapter, CollectionColumn } from "./LibraryCollection";
import { t } from "@/i18n";

const NO_USES: never[] = [];

function assetColumns(width: number): CollectionColumn[] {
  const columns: CollectionColumn[] = [
    { id: "name", label: t("名稱"), width: "minmax(14rem,2.4fr)", sort: "name" },
    { id: "kind", label: t("類型"), width: "5rem" },
    { id: "dimensions", label: t("解析度"), width: "6.5rem" },
    { id: "duration", label: t("長度"), width: "5.5rem", sort: "duration", align: "end" },
    { id: "size", label: t("大小"), width: "6rem", sort: "size", align: "end" },
    { id: "uses", label: t("使用"), width: "4.5rem", align: "end" },
  ];
  if (width >= 900) columns.push({ id: "note", label: t("備註"), width: "minmax(8rem,1.6fr)" });
  if (width >= 1060) columns.push({ id: "created", label: t("加入時間"), width: "9.5rem", sort: "created" });
  return columns;
}

/** 參考素材的 adapter（uses＝每個素材的使用處，見 model/library 的 libraryUses）。 */
export function assetAdapter(uses: ReadonlyMap<string, readonly LibraryUse[]>): CollectionAdapter<StudioLibraryItem> {
  const countOf = (item: StudioLibraryItem) => libraryUseCount(uses.get(item.item_id) ?? NO_USES);
  return {
    idOf: (item) => item.item_id,
    titleOf: (item) => item.name,
    columns: assetColumns,
    cell(item, columnId) {
      switch (columnId) {
        case "name":
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid h-8 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
                <LibraryThumb item={item} />
              </span>
              <span className="truncate text-data text-fg">{item.name}</span>
            </span>
          );
        case "kind":
          return (
            <span className="flex items-center gap-1.5">
              <KindIcon kind={item.kind} className="size-3.5" />
              {KIND_LABEL[item.kind]}
            </span>
          );
        case "dimensions":
          return <span className="machine">{itemDimensions(item)}</span>;
        case "duration":
          return <span className="machine">{itemDuration(item)}</span>;
        case "size":
          return <span className="machine">{itemSize(item)}</span>;
        case "uses": {
          const count = countOf(item);
          return count > 0 ? <UseBadge count={count} className="text-brand-cyan" /> : <span className="text-fg-disabled">—</span>;
        }
        case "note":
          return <span className="truncate">{item.note ?? ""}</span>;
        case "created":
          return <span className="machine truncate">{formatTimestamp(item.created_at)}</span>;
        default:
          return null;
      }
    },
    tile(item, thumbHeight) {
      const count = countOf(item);
      return (
        <>
          <span className="relative grid place-items-center overflow-hidden rounded-lg border border-line-subtle bg-stage" style={{ height: thumbHeight }}>
            <LibraryThumb item={item} className={THUMB_ZOOM} />
            <span className={cn(HUD_CHIP, "absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 text-[11px]")}>
              <KindIcon kind={item.kind} className="size-3" />
              {KIND_LABEL[item.kind]}
            </span>
            {item.kind !== "image" ? <span className={cn(HUD_CHIP, "machine absolute right-1.5 bottom-1.5 px-1.5 text-[11px]")}>{itemDuration(item)}</span> : null}
            {count > 0 ? <UseBadge count={count} className={cn(HUD_CHIP, "absolute top-1.5 right-1.5 px-1.5 text-[11px] text-brand-cyan")} /> : null}
          </span>
          <span className="truncate px-0.5 text-caption text-fg">{item.name}</span>
          <span className="machine truncate px-0.5 text-[11px] leading-4 text-fg-tertiary">{item.kind === "audio" ? itemSize(item) : `${itemDimensions(item)} · ${itemSize(item)}`}</span>
        </>
      );
    },
  };
}
