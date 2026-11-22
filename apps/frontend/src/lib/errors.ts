// 錯誤正規化：ApiError、契約 Error body（run／step／last_error）、一般例外 → 同一種顯示資料。
import { ApiError } from "@/api/http";
import type { ErrorKind } from "@/api/generated/errorCodes";
import { errorHeadline, errorHint, errorKind } from "@/i18n/errors";
import { isRecord } from "./json";
import { getLocale, t, tServer } from "@/i18n";

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
  if (isRecord(error) && typeof error["code"] === "string") {
    return {
      code: error["code"],
      message: typeof error["message"] === "string" && error["message"] ? error["message"] : error["code"],
      status: null,
      details: isRecord(error["details"]) ? error["details"] : {},
      remoteOutcomeUnknown: error["remote_outcome_unknown"] === true,
      headline: errorHeadline(error["code"]),
      hint: errorHint(error["code"]),
      kind: errorKind(error["code"]),
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

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_ID_RE = new RegExp(`\\brun\\s+(${UUID_SOURCE})`, "giu");
const UUID_RE = new RegExp(UUID_SOURCE, "giu");
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u;

/** Finds the name of a run the app has already read (the query cache); null when it is not known. */
export type RunNamer = (runId: string) => string | null;
let runNamer: RunNamer = () => null;

/** Set once by the app's query client, so failure texts can name runs instead of showing their ids. */
export function setRunNamer(namer: RunNamer): void {
  runNamer = namer;
}

/**
 * Replaces the ids a person cannot read in a server message: 「run <id>」 becomes the run's name (or 「另一個工作」 when
 * the app has not read that run), any other id (file, node, component instance) is left out.
 */
export function humanizeIds(text: string): string {
  return text
    .replace(RUN_ID_RE, (_match, id: string) => {
      const name = runNamer(id.toLowerCase());
      return name === null ? t("另一個工作") : t("「{name}」", { name });
    })
    .replace(UUID_RE, "")
    .replace(/[ \t]{2,}/gu, " ")
    // Chinese has no spaces between words: a space left between two Chinese characters or brackets goes
    .replace(/([\u3400-\u9fff」）])[ \t]+(?=[\u3400-\u9fff「（])/gu, "$1")
    .replace(/[ \t]+([，。；：、）」,.;:)])/gu, "$1")
    .replace(/([（「(])[ \t]+/gu, "$1")
    .replace(/（）|\(\)/gu, "")
    .trim();
}

/**
 * The words a person reads for a failure, everywhere the UI shows one: the server's message in the interface language
 * (a fixed message translated), without the error code and with readable names instead of ids. A message the catalog
 * cannot translate (a dynamic one) is shown as it is in the source language; in another language the code's localized
 * headline and next step stand in for it in English, instead of Chinese the reader may not read.
 */
export function failureText(code: string, message: string | null | undefined, details: Record<string, unknown> = {}): string {
  const source = message ?? "";
  const translated = tServer(source);
  // Japanese readers read the Chinese source well enough; English readers get the headline instead
  const unreadable = translated === source && getLocale() === "en" && CJK_RE.test(source);
  let text = unreadable ? "" : humanizeIds(translated);
  const holder = details["active_run_id"];
  if (text && typeof holder === "string") {
    const name = runNamer(holder.toLowerCase());
    if (name !== null) text = t("{text}（{name}）", { text, name });
  }
  if (text) return text;
  const headline = errorHeadline(code);
  const hint = errorHint(code);
  if (headline !== null && hint !== null) return t("{headline}：{hint}", { headline, hint });
  return headline ?? (humanizeIds(translated) || code);
}

export interface ErrorTextOptions {
  /** Where to check when a write's remote outcome is unknown (default REMOTE_UNKNOWN_TEXT). */
  remoteUnknown?: string;
}

/**
 * One-line error text for notices and inline errors: failureText (the message in plain words, no error code, no ids),
 * and the remote-outcome warning appended once when a write may or may not have happened (never when the message
 * already says so).
 */
export function errorText(error: unknown, options: ErrorTextOptions = {}): string {
  const info = toErrorInfo(error);
  const base = failureText(info.code, info.message, info.details);
  if (!writeOutcomeUnknown(error)) return base;
  const remoteUnknown = options.remoteUnknown ?? REMOTE_UNKNOWN_TEXT;
  return base.includes(remoteUnknown) || mentionsRemoteUnknown(info.message) ? base : t("{base}（{remoteUnknown}）", { base, remoteUnknown });
}
