// What the asset library's full-size preview (LibraryPreview) shows for a reference asset or a render.
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { renderEntryName, type RenderEntry } from "../../model/library";
import { itemFacts } from "../../references/display";
import { KIND_LABEL } from "../../references/materials";
import { renderDimensions, renderDuration } from "./display";
import type { PreviewMedia } from "./LibraryPreview";

/** 預覽用的媒體（參考素材或渲染成品）。 */
export function assetMedia(item: StudioLibraryItem): PreviewMedia {
  const facts = itemFacts(item);
  return { key: item.item_id, url: mediaUrl(item.file.node_id, item.file.file_id), kind: item.kind, name: item.name, facts: [KIND_LABEL[item.kind], ...(facts ? [facts] : [])] };
}

export function renderMedia(entry: RenderEntry): PreviewMedia {
  const file = entry.asset.file;
  return {
    key: entry.id,
    url: mediaUrl(file.node_id, file.file_id),
    kind: "video",
    name: renderEntryName(entry),
    facts: [...(entry.kind === "take" && entry.take.seed !== null ? [`seed ${String(entry.take.seed)}`] : []), renderDimensions(entry), renderDuration(entry)],
  };
}
