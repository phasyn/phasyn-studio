import { t } from "@/i18n";
// RecorderConfig 中後端尚未實作（或固定行為）的欄位：UI 停用並說明現況，不假裝套用。
// packages/、runtimes/ 的 Python 都沒有讀取 tensor_dump、finite_scan、trace_parts；
// stderr 由 Node supervisor 一律擷取並轉成 log 事件（phasyn_node/supervisor.py），capture_stderr 不影響行為。
export interface RecorderFieldSupport {
  status: "unimplemented" | "always_on";
  /** 顯示給使用者的現況說明。 */
  note: string;
}

export const RECORDER_FIELD_SUPPORT: Readonly<Record<string, RecorderFieldSupport>> = {
  tensor_dump: { status: "unimplemented", note: t("尚未實作：後端沒有讀取這個欄位，開啟也不會存下任何 tensor。") },
  finite_scan: { status: "unimplemented", note: t("尚未實作：後端沒有讀取這個欄位，不會做 NaN／Inf 檢查。") },
  trace_parts: { status: "unimplemented", note: t("尚未實作：trace 目前只依 trace_steps 篩選，這個欄位不影響行為。") },
  capture_stderr: { status: "always_on", note: t("固定開啟：Node 一律擷取元件程序的 stderr 並轉成 log 事件，這個開關目前不影響行為。") },
};

export function recorderFieldSupport(key: string): RecorderFieldSupport | null {
  return RECORDER_FIELD_SUPPORT[key] ?? null;
}

export const RECORDER_SUPPORT_LABEL: Record<RecorderFieldSupport["status"], string> = {
  unimplemented: t("尚未實作"),
  always_on: t("固定開啟"),
};
