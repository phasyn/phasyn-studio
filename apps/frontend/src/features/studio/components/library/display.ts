// 素材庫的顯示文字（純函式）：尺寸、長度、大小、來源。未知就說未知，不顯示 0。
import type { StudioLibraryItem } from "@/api/generated/contracts";
import type { RenderEntry } from "../../model/library";
import { formatBytes } from "@/lib/format";
import { t } from "@/i18n";

export function itemDimensions(item: StudioLibraryItem): string {
  return item.width !== null && item.height !== null ? `${String(item.width)}×${String(item.height)}` : "—";
}

/** 長度（m:ss.s；圖片沒有長度）。 */
export function itemDuration(item: StudioLibraryItem): string {
  if (item.kind === "image") return "—";
  return clockDuration(item.duration_seconds);
}

/** 秒數 → m:ss.s；null＝長度未知。 */
function clockDuration(total: number | null): string {
  if (total === null) return t("長度未知");
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function itemSize(item: StudioLibraryItem): string {
  return formatBytes(item.file.size_bytes);
}

export function itemAudioTrack(item: StudioLibraryItem): string | null {
  if (item.kind !== "video") return null;
  return item.has_audio === null ? t("音軌未知") : item.has_audio ? t("有音軌") : t("無音軌");
}

export function itemSource(item: StudioLibraryItem): string {
  if (item.source?.kind === "run_output") return t("執行輸出") + " · " + item.source.output_key;
  return item.source?.kind === "image_take" ? t("Image Studio 的 take") : t("上傳");
}

/** 素材庫的總大小。 */
export function totalSize(items: readonly StudioLibraryItem[]): string {
  return formatBytes(items.reduce((sum, item) => sum + item.file.size_bytes, 0));
}

/** 渲染成品（take 或序列匯出）的解析度、長度與大小。 */
export function renderDimensions(entry: RenderEntry): string {
  return `${String(entry.asset.width)}×${String(entry.asset.height)}`;
}

export function renderDuration(entry: RenderEntry): string {
  return clockDuration(entry.durationSeconds);
}

export function renderSize(entry: RenderEntry): string {
  return formatBytes(entry.asset.file.size_bytes);
}

export function renderTotalSize(entries: readonly RenderEntry[]): string {
  return formatBytes(entries.reduce((sum, entry) => sum + entry.asset.file.size_bytes, 0));
}
