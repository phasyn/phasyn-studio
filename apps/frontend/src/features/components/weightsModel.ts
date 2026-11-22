// 模型權重的純邏輯（WeightsDialog 用）：要從來源下載多少、能以 hard link 共用多少、
// 接著下載的暫存檔、大小不同的檔案，以及現在能不能開始下載。數字都來自 Node 的檔案狀態，不估算。
import type { ComponentDescriptor, WeightsDownloadJob, WeightsView } from "@/api/generated/contracts";
import { formatBytes } from "@/lib/format";
import { t, tServer } from "@/i18n";

export interface WeightsTotals {
  files: number;
  bytes: number;
  presentFiles: number;
  presentBytes: number;
  /** 要從來源下載的檔案，與還要傳輸的位元組（扣掉暫存檔裡已有的部分）。 */
  downloadFiles: number;
  downloadBytes: number;
  /** 內容相同的檔案已在磁碟上：驗證雜湊後以 hard link 共用，不下載。 */
  linkFiles: number;
  linkBytes: number;
  /** 暫存檔裡已經有的位元組（接著下載，不重下）。 */
  resumeBytes: number;
  mismatchFiles: number;
  mismatchBytes: number;
}

/** 計畫裡全部檔案的統計；兩組權重放到同一個位置的檔案只算一次（Node 也只下載一次）。 */
export function weightsTotals(view: WeightsView, replaceMismatched: boolean): WeightsTotals {
  const totals: WeightsTotals = {
    files: 0,
    bytes: 0,
    presentFiles: 0,
    presentBytes: 0,
    downloadFiles: 0,
    downloadBytes: 0,
    linkFiles: 0,
    linkBytes: 0,
    resumeBytes: 0,
    mismatchFiles: 0,
    mismatchBytes: 0,
  };
  const seen = new Set<string>();
  for (const set of view.sets) {
    for (const file of set.files) {
      const key = set.dest ? `${set.dest}/${file.path}` : file.path;
      if (seen.has(key)) continue;
      seen.add(key);
      totals.files += 1;
      totals.bytes += file.size;
      if (file.status === "present") {
        totals.presentFiles += 1;
        totals.presentBytes += file.size;
      } else if (file.status === "mismatch") {
        totals.mismatchFiles += 1;
        totals.mismatchBytes += file.size;
        if (replaceMismatched) {
          totals.downloadFiles += 1;
          totals.downloadBytes += file.size;
        }
      } else if (file.link_from != null && file.link_from !== "") {
        totals.linkFiles += 1;
        totals.linkBytes += file.size;
      } else {
        const partial = file.partial_bytes ?? 0;
        totals.downloadFiles += 1;
        totals.downloadBytes += file.size - partial;
        totals.resumeBytes += partial;
      }
    }
  }
  return totals;
}

/** 這次下載要處理的檔案數（下載＋共用＋要取代的）。 */
export function pendingFiles(totals: WeightsTotals): number {
  return totals.downloadFiles + totals.linkFiles;
}

export interface DownloadContext {
  descriptor: Pick<ComponentDescriptor, "state">;
  view: WeightsView;
  totals: WeightsTotals;
  accepted: boolean;
  stale: boolean;
}

/** 現在不能開始下載的原因（依序檢查，給按鈕的停用說明）；可以 → null。 */
export function downloadBlockedReason({ descriptor, view, totals, accepted, stale }: DownloadContext): string | null {
  if (stale) return t("Node 離線（目錄是過時快照）：無法下載");
  if (view.job?.state === "running") return t("下載進行中");
  if (view.sets.length === 0) return t("這個元件沒有可以下載的權重");
  if (!(view.root != null && view.root !== "")) return (view.notes[0] != null && view.notes[0] !== "") ? tServer(view.notes[0]) : t("未設定模型目錄（load.model_path）");
  if (descriptor.state !== "stopped" && descriptor.state !== "error") return t("元件停止時才能下載權重：先停止元件");
  if (pendingFiles(totals) === 0) {
    return totals.mismatchFiles > 0 ? t("只剩大小不同的檔案：勾選「取代大小不同的檔案」才會重新下載") : t("沒有缺少的檔案");
  }
  if (view.free_bytes !== null && totals.downloadBytes > view.free_bytes) {
    return t("磁碟剩餘空間不足：需要 {need}，剩 {free}", { need: formatBytes(totals.downloadBytes), free: formatBytes(view.free_bytes) });
  }
  if (!accepted) return t("先閱讀並勾選同意上面的授權條款");
  return null;
}

/** 下載工作的位元組進度（0–1）；沒有要傳輸的位元組（全部共用）時 null。 */
export function jobFraction(job: Pick<WeightsDownloadJob, "bytes_done" | "bytes_total">): number | null {
  return job.bytes_total > 0 ? Math.min(1, job.bytes_done / job.bytes_total) : null;
}

/** 開始下載後還能不能接著下載（失敗或取消、而且還有沒完成的檔案）。 */
export function canResume(view: WeightsView, totals: WeightsTotals): boolean {
  const state = view.job?.state;
  return (state === "failed" || state === "cancelled") && pendingFiles(totals) > 0;
}
