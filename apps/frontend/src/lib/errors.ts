// 錯誤正規化：ApiError、契約 Error body（run／step／last_error）、一般例外 → 同一種顯示資料。
import { ApiError } from "@/api/http";
import type { ErrorKind } from "@/api/generated/errorCodes";
import { errorHeadline, errorHint, errorKind } from "@/i18n/errors";
import { isRecord } from "./json";
import { t, tServer } from "@/i18n";

export interface ErrorInfo {
  code: string;
  message: string;
  status: number | null;
  details: Record<string, unknown>;
  remoteOutcomeUnknown: boolean;
  /** 依錯誤碼的在地化標題（「這是哪一類錯誤」）；未知錯誤碼與前端例外為 null（改用 message 當標題）。 */
  headline: string | null;
  /** 依錯誤碼的下一步提示（沒有專屬提示時依 kind）。 */
  hint: string | null;
  /** The server registry's kind (client, conflict, unavailable, remote, internal); null for client-side codes. */
  kind: ErrorKind | null;
}

export const REMOTE_UNKNOWN_TEXT = t("遠端結果未知：Node 可能仍在運算，請查看該元件狀態與紀錄");

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status === 0 ? null : error.status,
      details: error.details,
      remoteOutcomeUnknown: error.remoteOutcomeUnknown,
      headline: errorHeadline(error.code),
      hint: errorHint(error.code),
      kind: errorKind(error.code),
    };
  }
  if (isRecord(error) && typeof error.code === "string") {
    return {
      code: error.code,
      message: typeof error.message === "string" && error.message ? error.message : error.code,
      status: null,
      details: isRecord(error.details) ? error.details : {},
      remoteOutcomeUnknown: error.remote_outcome_unknown === true,
      headline: errorHeadline(error.code),
      hint: errorHint(error.code),
      kind: errorKind(error.code),
    };
  }
  if (error instanceof Error) {
    return { code: error.name || "ERROR", message: error.message, status: null, details: {}, remoteOutcomeUnknown: false, headline: null, hint: null, kind: null };
  }
  return { code: "ERROR", message: typeof error === "string" ? error : t("發生未預期的錯誤"), status: null, details: {}, remoteOutcomeUnknown: false, headline: null, hint: null, kind: null };
}

/** 是否為特定錯誤碼（例如 RUN_ACTIVE、REVISION_CONFLICT）。 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return toErrorInfo(error).code === code;
}

/** 寫入請求連線中斷：遠端是否完成不得而知（讀取不會改變任何東西，所以 GET 的連線中斷不算）。 */
export function writeOutcomeUnknown(error: unknown): boolean {
  if (error instanceof ApiError) return error.remoteOutcomeUnknown || ((error.status === 0 || error.status === 504) && error.method !== "GET");
  return toErrorInfo(error).remoteOutcomeUnknown;
}

/** The text already says the remote outcome is unknown (the Controller's own zh-Hant words or their translation). */
function mentionsRemoteUnknown(text: string): boolean {
  return text.includes("遠端結果未知") || text.includes(t("遠端結果未知")); // i18n-ignore: the first is the server's original text
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

export interface ErrorTextOptions {
  /** Where to check when a write's remote outcome is unknown (default REMOTE_UNKNOWN_TEXT). */
  remoteUnknown?: string;
}

/**
 * One-line error text for notices and inline errors: "{code}：{message}" for coded errors, the message otherwise (a fixed
 * server message is shown translated), and the remote-outcome warning appended once when a write may or may not have
 * happened (never when the message already says so).
 */
export function errorText(error: unknown, options: ErrorTextOptions = {}): string {
  const info = toErrorInfo(error);
  const message = tServer(info.message);
  const base = CODE_PATTERN.test(info.code) && info.message !== info.code ? t("{code}：{message}", { code: info.code, message }) : message;
  if (!writeOutcomeUnknown(error)) return base;
  const remoteUnknown = options.remoteUnknown ?? REMOTE_UNKNOWN_TEXT;
  return base.includes(remoteUnknown) || mentionsRemoteUnknown(info.message) ? base : t("{base}（{remoteUnknown}）", { base, remoteUnknown });
}
