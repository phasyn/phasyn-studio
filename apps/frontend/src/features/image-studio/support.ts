// Image Studio 的共用小工具（非元件）：錯誤文字、站內網址。
import { errorText as sharedErrorText } from "@/lib/errors";
import { t } from "@/i18n";

/** 寫入（生成、上傳、保存）的遠端結果未知時，到哪裡確認（不自動重送）。 */
export const REMOTE_UNKNOWN = t("遠端結果未知：請到「紀錄・執行紀錄」確認，不要直接重送");

/** 錯誤的一行說明（共用的 errorText，加上 Image Studio 的確認位置）。 */
export function errorText(error: unknown): string {
  return sharedErrorText(error, { remoteUnknown: REMOTE_UNKNOWN });
}

/** 圖片頁面的網址（同一個專案；shot／take 可省略）。 */
export function imagePath(projectId: string, params: { shot?: string | null; take?: string | null } = {}): string {
  const search = new URLSearchParams({ project: projectId });
  if (params.shot) search.set("shot", params.shot);
  if (params.take) search.set("take", params.take);
  return `/image?${search.toString()}`;
}
