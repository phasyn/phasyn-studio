// 參考素材的顯示文字（純函式）。
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { formatSeconds } from "../prompt/blocks";
import { t } from "@/i18n";

/** 媒體資訊（未知就說未知，不顯示 0）。 */
export function itemFacts(item: StudioLibraryItem): string {
  const parts: string[] = [];
  if (item.kind !== "image") parts.push(item.duration_seconds === null ? t("長度未知") : t("{duration_seconds} 秒", { duration_seconds: formatSeconds(item.duration_seconds, 1) }));
  if (item.width !== null && item.height !== null) parts.push(`${item.width}×${item.height}`);
  if (item.kind === "video") parts.push(item.has_audio === null ? t("音軌未知") : item.has_audio ? t("有音軌") : t("無音軌"));
  return parts.join(" · ");
}
