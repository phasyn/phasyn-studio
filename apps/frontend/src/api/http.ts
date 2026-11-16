// 唯一的 HTTP 傳輸 seam：同源 /api，沒有登入、權杖或驗證標頭。
// 寫入（POST/PUT/PATCH）一律不自動重送：timeout 表示遠端結果未知，由使用者決定是否建立新的請求。
import type { ApiErrorBody } from "./generated/contracts";
import { t } from "@/i18n";
import { hasDotSegment, pathSegment } from "@/lib/url";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * This tab, as the Controller's Studio audit trail names it (X-Phasyn-Client): one random id per page load, so a write
 * that lost someone's edit can be traced to the tab that sent it. It identifies a tab, never a person.
 */
export const CLIENT_ID = `studio-tab/${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8)}`;
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 頁面卸載時仍送出（例如離開前最後一次保存）；結果不保證可讀回。 */
  keepalive?: boolean;
}

/** API 錯誤：保留 contract Error 的 code／message／details 與 HTTP 狀態。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly remoteOutcomeUnknown: boolean;
  /** The request's method when the error came from apiFetch; null for errors built elsewhere (treated as a write). */
  readonly method: HttpMethod | null;

  constructor(status: number, body: Partial<ApiErrorBody> | null, fallback: string, method: HttpMethod | null = null) {
    super(body?.message ?? fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code ?? (status === 0 ? "NETWORK_ERROR" : `HTTP_${status}`);
    this.details = body?.details ?? {};
    this.remoteOutcomeUnknown = Boolean(body?.remote_outcome_unknown);
    this.method = method;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** 同源相對路徑＋查詢字串；null／undefined／空字串的參數不送出。 */
export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asErrorBody(value: unknown): Partial<ApiErrorBody> | null {
  if (value && typeof value === "object" && "code" in value && "message" in value) {
    return value as Partial<ApiErrorBody>;
  }
  return null;
}

/** 發出請求並回傳原始 Response（下載、串流用）；非 2xx 轉成 ApiError。 */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json", "X-Phasyn-Client": CLIENT_ID, ...options.headers };
  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const method = options.method ?? "GET";
  // 路徑由 id 組成：id 是 "." 或 ".." 時瀏覽器會把請求導到上一層，這種請求不送出。
  if (hasDotSegment(path)) throw new ApiError(0, null, t("請求路徑含有不合法的區段，沒有送出"), method);
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      signal: options.signal,
      keepalive: options.keepalive,
      credentials: "same-origin",
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    // A read changes nothing: only a write that lost its connection has an unknown remote outcome
    const message =
      method === "GET"
        ? t("無法連線 Controller；確認服務仍在執行後重新讀取")
        : t("無法連線 Controller；寫入請求的遠端結果未知，請重新讀取狀態後再決定是否重試");
    throw new ApiError(0, null, message, method);
  }
  if (!response.ok) {
    const parsed = await readBody(response);
    throw new ApiError(response.status, asErrorBody(parsed), `HTTP ${response.status}`, method);
  }
  return response;
}

/** JSON 請求。 */
export async function apiJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  return (await readBody(response)) as T;
}

/** 瀏覽器可直接播放／下載的 Node 檔案 URL（Controller 轉送，支援單一 Range）。 */
export function mediaUrl(nodeId: string, fileId: string): string {
  return `/api/media/${pathSegment(nodeId)}/${pathSegment(fileId)}`;
}

/** Categories GET …/export can redact ("all" = every one). Only the downloaded copy is redacted, never the recording. */
export type ExportRedaction = "hostname" | "device_ids" | "prompts" | "paths" | "all";

/** Download URL of a recording export; `redact` is sent comma-separated (the server refuses it for "trace"). */
export function exportUrl(recordingId: string, format: "jsonl" | "csv" | "zip" | "trace", redact: readonly ExportRedaction[] = []): string {
  return buildUrl(`/api/recordings/${pathSegment(recordingId)}/export`, { format, redact: redact.length > 0 ? redact.join(",") : null });
}
