// 唯一的 HTTP 傳輸 seam：同源 /api，沒有登入、權杖或驗證標頭。
// 寫入（POST/PUT/PATCH）一律不自動重送：timeout 表示遠端結果未知，由使用者決定是否建立新的請求。
import type { ApiErrorBody, PhasynStudioContracts } from "./generated/contracts";
import type { DeleteComponentResult } from "./components";
import type { PipelineList } from "./pipelines";
import type { DeletedPreset } from "./presets";
import type { PurgeResult } from "./runs";
import type { RunPage, RunRequestBody, WirePipeline, WireRun } from "./types";
import { matchesWireShape, wireDefinitions } from "@/lib/contractSchemas";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { hasDotSegment, pathSegment } from "@/lib/url";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * This tab, as the Controller's Studio audit trail names it (X-Phasyn-Client): one random id per page load, so a write
 * that lost someone's edit can be traced to the tab that sent it. It identifies a tab, never a person.
 */
export const CLIENT_ID = `studio-tab/${Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
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
    this.code = body?.code ?? (status === 0 ? "NETWORK_ERROR" : `HTTP_${String(status)}`);
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

export function asErrorBody(value: unknown): Partial<ApiErrorBody> | null {
  if (!isRecord(value) || typeof value["code"] !== "string" || typeof value["message"] !== "string") return null;
  return {
    code: value["code"], message: value["message"],
    ...(isRecord(value["details"]) ? { details: value["details"] } : {}),
    ...(typeof value["remote_outcome_unknown"] === "boolean" ? { remote_outcome_unknown: value["remote_outcome_unknown"] } : {}),
  };
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
      ...(body === undefined ? {} : { body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
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
    throw new ApiError(response.status, asErrorBody(parsed), `HTTP ${String(response.status)}`, method);
  }
  return response;
}

/** JSON 請求。 */
export async function apiJson(path: string, options: RequestOptions = {}): Promise<unknown> {
  return readBody(await apiFetch(path, options));
}

export type ControllerReplies = Required<PhasynStudioContracts> & {
  WireRunRequest: RunRequestBody; WireRun: WireRun; WirePipeline: WirePipeline; RunPage: RunPage; PipelineList: PipelineList;
  DeletedPipeline: { pipeline_id: string; deleted: boolean }; DeletedRecording: { recording_id: string; deleted: boolean };
  DeletedPreset: DeletedPreset; DeleteComponentResult: DeleteComponentResult; PurgeResult: PurgeResult;
};
export type ReplyName = keyof ControllerReplies;

const wireNames: Partial<Record<ReplyName, string>> = {
  WireRunRequest: "RunRequest", ApiErrorBody: "Error", RecordingEvent: "Event", WireRun: "Run", WirePipeline: "Pipeline",
  RunPage: "ListRuns", PipelineList: "ListPipelines",
};
const strings = { type: "array", items: { type: "string" } };
const integer = { type: "integer" };
const nullableInteger = { type: ["integer", "null"] };
const stringField = { type: "string" };
const removed = (key: string, deleted: { const: true } | { type: "boolean" } = { const: true }) => ({ type: "object", required: [key, "deleted"], properties: { [key]: stringField, deleted } });
const extensions: Partial<Record<ReplyName, unknown>> = {
  DeletedPipeline: removed("pipeline_id", { type: "boolean" }), DeletedRecording: removed("recording_id", { type: "boolean" }),
  DeletedPreset: removed("preset_id"),
  DeleteComponentResult: removed("component_id"),
  PurgeResult: {
    type: "object", required: ["run_id", "dry_run", "deleted", "files", "recordings", "projects"],
    properties: {
      run_id: stringField, dry_run: { type: "boolean" }, deleted: { type: "boolean" },
      files: { type: "array", items: {
        type: "object", required: ["node_id", "file_id", "size_bytes", "status"],
        properties: { node_id: stringField, file_id: stringField, size_bytes: nullableInteger, status: { enum: ["planned", "deleted", "missing", "failed"] }, code: stringField, message: stringField },
      } },
      recordings: { type: "object", required: ["planned", "deleted"], properties: { planned: integer, deleted: integer } },
      projects: { type: "array", items: {
        type: "object", required: ["project_id", "title", "takes_removed", "exports_removed", "revision"],
        properties: { project_id: stringField, title: stringField, takes_removed: strings, exports_removed: strings, revision: nullableInteger },
      } },
    },
  },
};

export function matchesReply<K extends ReplyName>(value: unknown, name: K, definitions: Record<string, unknown>): value is ControllerReplies[K] {
  return matchesWireShape(value, extensions[name] ?? definitions[wireNames[name] ?? name], definitions);
}

/** Start the HTTP request immediately, including keepalive on page exit; check its reply without resubmitting. */
export async function contractJson<K extends ReplyName>(name: K, path: string, options: RequestOptions = {}): Promise<ControllerReplies[K]> {
  const [value, definitions] = await Promise.all([apiJson(path, options), wireDefinitions()]);
  if (matchesReply(value, name, definitions)) return value;
  const method = options.method ?? "GET";
  throw new ApiError(0, { code: "INVALID_RESPONSE", remote_outcome_unknown: method !== "GET" }, t("回應格式不正確"), method);
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
