// 分類與排序的狀態與錯誤說明（純函式，繁中）：不能調整的原因、保存失敗時給使用者的話。
import { isNotFound, layoutSaveCause, unknownPipelineIds } from "@/api/pipelines";
import { hasErrorCode, toErrorInfo, writeOutcomeUnknown } from "@/lib/errors";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const LAYOUT_UNSUPPORTED = t("主控尚未支援元件組合分類（需要更新並重新啟動主控）");

/** 不能調整分類與排序的原因；可以調整時回傳 null。 */
export function layoutBlockedReason(state: { pipelinesReady: boolean; layoutPending: boolean; layoutError: unknown }): string | null {
  if (!state.pipelinesReady) return t("元件組合清單尚未讀取");
  if (state.layoutPending) return t("正在讀取分類與排序…");
  if (state.layoutError === null || state.layoutError === undefined) return null;
  if (isNotFound(state.layoutError)) return LAYOUT_UNSUPPORTED;
  return t("無法讀取分類與排序：{message}", { message: toErrorInfo(state.layoutError).message });
}

/** 保存失敗（或因前一個失敗而沒有送出）時的說明；畫面已還原成伺服器確認的版本並重新讀取。 */
export function layoutSaveErrorMessage(error: unknown): string {
  const cause = layoutSaveCause(error);
  if (hasErrorCode(cause, "REVISION_CONFLICT")) return t("元件組合的分類與排序已在其他視窗或分頁變更，已重新載入最新的版本；請再操作一次。");
  const unknown = unknownPipelineIds(cause);
  if (unknown.length > 0) return t("有元件組合已被刪除（{unknown}），已重新載入；請再操作一次。", { unknown: formatList(unknown) });
  if (writeOutcomeUnknown(cause)) return t("無法確認變更是否已保存（連線中斷，遠端結果未知）；已重新讀取主控上的分類與排序，請確認後再操作。");
  if (isNotFound(cause)) return t("{layoutUnsupported}；變更已還原。", { layoutUnsupported: LAYOUT_UNSUPPORTED });
  return t("無法保存分類與排序：{message}；變更已還原。", { message: toErrorInfo(cause).message });
}
