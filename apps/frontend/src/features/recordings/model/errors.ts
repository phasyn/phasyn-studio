// API errors on the recordings pages → a headline plus the server's own code and message (never swallowed). Built on
// the shared toErrorInfo; only the headlines that read better in this context are overridden here.
import { isApiError } from "@/api/http";
import { toErrorInfo } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { t, tServer } from "@/i18n";

const PAGE_HEADLINES: Readonly<Record<string, () => string>> = {
  NETWORK_ERROR: () => t("無法連線 Controller；確認服務仍在執行後重新讀取"),
  RECORDING_NOT_FOUND: () => t("找不到此 recording：可能尚未上報到主控，或 ID 不正確"),
  TRACE_UNAVAILABLE: () => t("此 recording 沒有 trace"),
  NODE_UNREACHABLE: () => t("Node 無法連線；主控已有的紀錄副本仍可查詢"),
  INVALID_ARGUMENT: () => t("查詢參數不正確"),
};

export interface RecordingErrorView {
  code: string;
  status: number | null;
  headline: string;
  /** The server's message when the headline does not already say it. */
  serverMessage: string | null;
  remoteUnknown: boolean;
  details: Record<string, unknown>;
}

export function describeError(error: unknown): RecordingErrorView {
  if (error instanceof SyntaxError) {
    return { code: "PARSE_ERROR", status: null, headline: t("回應不是有效的 JSON"), serverMessage: error.message, remoteUnknown: false, details: {} };
  }
  if (!isApiError(error) && !(isRecord(error) && typeof error.code === "string")) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: "CLIENT_ERROR", status: null, headline: message || t("未知錯誤"), serverMessage: null, remoteUnknown: false, details: {} };
  }
  const info = toErrorInfo(error);
  // A fixed server message is shown in the interface language (tServer leaves other text as it is).
  const message = tServer(info.message);
  const headline = PAGE_HEADLINES[info.code]?.() ?? (info.status === 404 ? t("找不到要求的資料") : null) ?? info.headline ?? message;
  return {
    code: info.code,
    status: info.status,
    headline,
    serverMessage: message && message !== headline ? message : null,
    remoteUnknown: info.remoteOutcomeUnknown,
    details: info.details,
  };
}
