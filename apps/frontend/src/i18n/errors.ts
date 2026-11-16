// Error code → localized headline ("what kind of error") and next-step hint. The server's own message is still shown
// verbatim under the headline (never rewritten or swallowed) and details are listed as they are.
// New code: add one entry here and its ja / en translations in catalogs/{ja,en}/errors.json (pnpm test checks them).
import { ERROR_CODE_KINDS, type ErrorKind } from "@/api/generated/errorCodes";
import { t } from "./index";

interface ErrorText {
  headline: () => string;
  hint?: () => string;
}

const ERROR_TEXTS: Readonly<Record<string, ErrorText>> = {
  INVALID_ARGUMENT: { headline: () => t("參數不正確"), hint: () => t("修正參數或接線後再送出；系統不會猜測轉換。") },
  BAD_REQUEST: { headline: () => t("請求格式不正確") },
  METHOD_NOT_ALLOWED: { headline: () => t("不支援這個操作") },
  UNSUPPORTED_SETTING: { headline: () => t("不支援的設定"), hint: () => t("provider 不支援此設定：改用 schema 允許的值，不會假裝套用。") },
  UNSUPPORTED_COMBINATION: { headline: () => t("不支援的設定組合") },
  MODEL_INCOMPATIBLE: { headline: () => t("模型與設定不相容"), hint: () => t("模型與設定不相容：調整實際不支援的設定。") },
  PROMPT_TOO_LONG: { headline: () => t("prompt 太長") },
  CONTEXT_BUDGET_EXCEEDED: { headline: () => t("超過模型的 context 上限") },
  INPUT_TOO_LARGE: { headline: () => t("輸入內容太大"), hint: () => t("inline 內容超過 256 KiB：大內容請改用檔案（FileRef）。") },
  RUBRIC_MISMATCH: { headline: () => t("評分規準不符") },
  AMBIGUOUS_STREAM: { headline: () => t("需要指定 stream"), hint: () => t("這筆紀錄有多個 stream：指定 stream_id 後再讀取。") },
  RANGE_NOT_SATISFIABLE: { headline: () => t("要求的範圍無效") },
  PORT_MISMATCH: { headline: () => t("接線型別或埠不符"), hint: () => t("接線型別或埠名稱不符：修正接線，系統不做自動轉換。") },
  CYCLIC_PIPELINE: { headline: () => t("元件組合有循環接線"), hint: () => t("接線有循環：移除循環依賴後再送出。") },
  STUDIO_TIMELINE_REJECTED: { headline: () => t("時間軸編輯被拒絕"), hint: () => t("時間軸沒有被修改：依訊息裡的原因調整後再試一次。") },
  LATENT_SOURCE_MISMATCH: { headline: () => t("latent 來源不符"), hint: () => t("latent 來源不符：原來源不會被修改。") },
  LATENT_MISMATCH: { headline: () => t("latent 不相符") },
  ENCODER_CONTRACT_MISMATCH: { headline: () => t("編碼器輸出與契約不符") },
  COMPONENT_NOT_READY: { headline: () => t("元件尚未就緒"), hint: () => t("元件未就緒：到元件頁手動 start 或等待載入完成；不會自動重試。") },
  COMPONENT_BUSY: { headline: () => t("元件正在執行呼叫"), hint: () => t("元件正在執行呼叫：先取消進行中的呼叫或等待結束。") },
  DEVICE_BUSY: { headline: () => t("裝置忙碌中"), hint: () => t("裝置忙碌：等待進行中的呼叫結束；不會自動重試。") },
  GPU_MEMORY_INSUFFICIENT: { headline: () => t("可用 GPU 記憶體不足（預檢）"), hint: () => t("記憶體預檢沒有通過，沒有載入或執行任何東西（不是 OOM）：停止同一張 GPU 上的其他元件或程序、改用較省記憶體的 offload 模式，或把元件移到另一張 GPU 後再試；不會自動重試，也不會降低精度。") },
  HOST_MEMORY_INSUFFICIENT: { headline: () => t("可用主記憶體不足（預檢）"), hint: () => t("主記憶體預檢沒有通過，沒有載入或執行任何東西（不是 OOM）：停止同一台主機上的其他元件或程序、改用需要較少主記憶體的 offload 或 pin 設定，或把元件移到另一台主機後再試；不會自動重試，也不會降低精度。") },
  HOST_PROTECTION: { headline: () => t("主機保護暫緩或取消了呼叫"), hint: () => t("Node 的主機保護在晶片或 GPU 太熱、或可用主記憶體太少時讓受保護的呼叫等待，緊急時取消它（訊息裡有讀數與門檻）：等主機降溫或釋放主記憶體後再送出；不會自動重試。") },
  EXCLUSIVE_GROUP_BUSY: { headline: () => t("互斥群組的元件正在使用中"), hint: () => t("同一台 Node 的互斥群組中有元件正在載入、停止或執行呼叫：等它完成後再啟動；不會自動重試。") },
  EXCLUSIVE_GROUP_CONFLICT: { headline: () => t("互斥群組已有載入的元件"), hint: () => t("同一台 Node 的互斥群組一次只能載入一個元件：確認後可以先停止閒置的元件再啟動。") },
  PAYLOAD_TOO_LARGE: { headline: () => t("請求或上傳太大"), hint: () => t("超過伺服器的大小上限（JSON 請求或單一上傳檔）：縮小內容，或請管理者調整 max_json_body_bytes／max_upload_bytes。") },
  UNSUPPORTED_MEDIA_TYPE: { headline: () => t("不支援的請求內容類型"), hint: () => t("這個端點只接受 application/json 的請求本文。") },
  BROWSER_REQUEST_REJECTED: { headline: () => t("Node 拒絕瀏覽器直接送出的請求"), hint: () => t("瀏覽器不能直接操作 Node（防止跨站請求）：請經由主控的介面或 API 操作。") },
  HOST_NOT_ALLOWED: { headline: () => t("Host 不在允許清單"), hint: () => t("請求的 Host 不在伺服器的 allowed_hosts：改用設定允許的位址連線，或請管理者調整 allowed_hosts。") },
  SETTINGS_NOT_LOADED: { headline: () => t("保存的設定尚未載入"), hint: () => t("已保存的設定尚未載入：在元件頁明確 restart 後再執行。") },
  REVISION_CONFLICT: { headline: () => t("設定已被更新（revision 衝突）"), hint: () => t("設定已被更新：重新讀取並檢視差異後再保存。") },
  RUN_ACTIVE: { headline: () => t("已有 run 正在執行"), hint: () => t("已有 run 正在執行（同時最多 1 個）：等它結束或取消後再送出新的 run。") },
  CALL_ID_CONFLICT: { headline: () => t("呼叫 ID 衝突") },
  STATE_CONFLICT: { headline: () => t("目前狀態不允許這個操作"), hint: () => t("目前狀態不允許此操作：重新讀取狀態後再決定。") },
  STUDIO_PLUGIN_INSTALL_DISABLED: {
    headline: () => t("主控關閉了插件的安裝與移除"),
    hint: () => t("主控設定檔的 plugins.install 是 disabled：改成 api 並重新啟動主控後才能安裝或移除；內建與開發目錄的插件不受影響。"),
  },
  STUDIO_PLUGIN_INVALID: {
    headline: () => t("插件包不合規"),
    hint: () => t("沒有安裝任何東西：依列出的問題修正插件包後再安裝一次。"),
  },
  TASK_RUNNING: { headline: () => t("任務正在執行"), hint: () => t("研究任務仍標記為執行中：先停止它或標記為已中斷，再進行這個操作。") },
  DUPLICATE_NODE_ID: { headline: () => t("Node ID 重複"), hint: () => t("另一台運作中的 Node 使用相同的 node_id：修改其中一台的 node_id 後重新啟動。") },
  WEIGHTS_DESTINATION_CONFLICT: {
    headline: () => t("目的地有大小不同的權重檔"),
    hint: () => t("模型目錄裡已有與固定版本大小不同的檔案，下載不會覆蓋它們：確認後勾選「取代大小不同的檔案」再下載，或自行處理這些檔案。"),
  },
  NOT_FOUND: { headline: () => t("找不到資源"), hint: () => t("找不到資源：可能已被移除或 ID 錯誤。") },
  FILE_NOT_FOUND: { headline: () => t("找不到檔案"), hint: () => t("找不到檔案：重新取得檔案；不會重跑上游步驟補檔。") },
  RECORDING_NOT_FOUND: { headline: () => t("找不到紀錄"), hint: () => t("找不到紀錄：可在紀錄頁確認或向 Node 抓取歷史。") },
  PREVIEW_NOT_FOUND: { headline: () => t("找不到預覽"), hint: () => t("這個呼叫或步驟目前沒有預覽：可能尚未產生或 provider 不提供；完成後請看最終輸出。") },
  TRACE_UNAVAILABLE: { headline: () => t("沒有 trace"), hint: () => t("這筆紀錄沒有 profiler trace：只有 recorder 模式設為 trace 的呼叫才會產生；其他紀錄資料不受影響。") },
  NODE_UNREACHABLE: { headline: () => t("無法連線 Node"), hint: () => t("Node 無法連線：遠端可能仍在運算，請稍後重新讀取狀態。") },
  CONTROLLER_UNREACHABLE: { headline: () => t("無法連線主控") },
  NODE_SHUTTING_DOWN: { headline: () => t("Node 正在關閉"), hint: () => t("Node 正在關閉：等它重新啟動後再送出；不會自動重試。") },
  CALL_TIMEOUT: { headline: () => t("呼叫逾時"), hint: () => t("呼叫逾時：自有程序已取消，實際退出狀態以紀錄為準。") },
  LOAD_TIMEOUT: { headline: () => t("載入逾時") },
  PROTOCOL_ERROR: { headline: () => t("通訊協定錯誤") },
  PROTOCOL_MISMATCH: { headline: () => t("協定版本不相容"), hint: () => t("協定版本不相容：改用相容版本的 Node／Controller。") },
  PROVIDER_NOT_INSTALLED: { headline: () => t("provider 未安裝"), hint: () => t("Node 的 runtime 沒有安裝此 provider：這是安裝缺口，不是權限問題。") },
  COMPONENT_NOT_CONFIGURED: { headline: () => t("元件尚未配置"), hint: () => t("元件缺少必要的設定或檔案：到元件頁補齊後再執行；不會自動重試。") },
  RUNTIME_NOT_CONFIGURED: { headline: () => t("runtime 尚未配置"), hint: () => t("這台 Node 沒有這個 runtime：檢查元件的 runtime 或 Node 設定的 runtimes。") },
  RUNTIME_UNAVAILABLE: { headline: () => t("runtime 無法使用") },
  WEIGHTS_SOURCE_UNAVAILABLE: {
    headline: () => t("權重來源無法下載"),
    hint: () => t("無法從權重來源（Hugging Face 或 HF_ENDPOINT）下載：確認 Node 能連上它；需要授權的模型請在 Node 的環境變數設定 HF_TOKEN 後重啟 Node。暫存檔保留，再按一次下載會接著下載；不會自動重試。"),
  },
  RUNTIME_START_FAILED: { headline: () => t("runtime 啟動失敗") },
  RUNTIME_EXITED: { headline: () => t("runtime 程序已結束") },
  UPSTREAM_PATCH_SOURCE_MISMATCH: { headline: () => t("上游函式已變更，拒絕套用修補") },
  PROCESS_EXIT_UNCONFIRMED: { headline: () => t("未能確認程序已結束") },
  NODE_INTERNAL_ERROR: { headline: () => t("Node 內部錯誤") },
  RUNTIME_ERROR: { headline: () => t("執行錯誤"), hint: () => t("執行錯誤：設定與 metrics 已保留，請檢查紀錄後手動調整。") },
  MODEL_OUTPUT_INVALID: { headline: () => t("模型輸出無法解讀") },
  GPU_OOM: { headline: () => t("顯存不足（GPU OOM）"), hint: () => t("顯存不足：設定與 metrics 已保留，請手動調整後建立新的 run。") },
  HOST_OOM: { headline: () => t("主記憶體不足"), hint: () => t("主記憶體不足：設定與 metrics 已保留，請減少同時載入的元件或手動調整後重新執行。") },
  RESOURCE_EXHAUSTED: { headline: () => t("資源不足") },
  DISK_FULL: { headline: () => t("磁碟已滿"), hint: () => t("磁碟已滿：清出空間（例如刪除不需要的紀錄或輸出檔）後再執行；不會自動重試。") },
  CANCELLED: { headline: () => t("已取消"), hint: () => t("呼叫已依要求取消（由你或系統發出）：需要時重新送出；不會自動重試。") },
  INTERRUPTED: { headline: () => t("已中斷") },
  MEDIA_TOOL_FAILED: { headline: () => t("媒體工具執行失敗") },
  FILE_TRUNCATED: { headline: () => t("檔案不完整"), hint: () => t("檔案不完整：重新取得檔案；不會重跑上游步驟補檔。") },
  FILE_HASH_MISMATCH: { headline: () => t("檔案雜湊不符"), hint: () => t("檔案雜湊不符：重新取得檔案；不會重跑上游步驟補檔。") },
  INTEGRITY_MISMATCH: { headline: () => t("完整性檢查不符"), hint: () => t("檔案已變更或未通過完整性檢查：重新取得檔案；不會重跑上游步驟補檔。") },
  MEDIA_INCOMPLETE: { headline: () => t("媒體未完成"), hint: () => t("媒體未完成：這不是完整成片，原來源不受影響。") },
  NETWORK_ERROR: { headline: () => t("無法連線主控"), hint: () => t("無法連線 Controller：確認服務後重新讀取狀態。") },
  PARSE_ERROR: { headline: () => t("回應不是有效的 JSON") },
  INVALID_RESPONSE: { headline: () => t("回應格式不正確") },
  INVALID_RESULT: { headline: () => t("結果無法解讀") },
  NOT_SENT: { headline: () => t("沒有送出") },
  OUTPUT_MISSING: { headline: () => t("找不到輸出") },
  RUN_NOT_FOUND: { headline: () => t("找不到 run") },
  RUN_MISMATCH: { headline: () => t("run 不相符") },
  IMAGE_MISSING: { headline: () => t("找不到圖片") },
  COMPONENT_MISSING: { headline: () => t("找不到元件") },
  CLIENT_ERROR: { headline: () => t("介面錯誤") },
  ERROR: { headline: () => t("錯誤") },
};

/** Codes with a headline (tests and docs). */
export const ERROR_HEADLINE_CODES: readonly string[] = Object.keys(ERROR_TEXTS);
/** Codes with their own next-step hint; the others fall back to their kind's generic hint. */
export const ERROR_HINT_CODES: readonly string[] = Object.keys(ERROR_TEXTS).filter((code) => ERROR_TEXTS[code]?.hint !== undefined);

/**
 * Codes the frontend produces itself; the server never sends them. With the server's error-code registry they make
 * up every code a headline may exist for (`HTTP_<status>` is handled by pattern).
 */
export const CLIENT_CODES: readonly string[] = [
  "NETWORK_ERROR",
  "PARSE_ERROR",
  "INVALID_RESPONSE",
  "INVALID_RESULT",
  "CLIENT_ERROR",
  "NOT_SENT",
  "OUTPUT_MISSING",
  "IMAGE_MISSING",
  "COMPONENT_MISSING",
  "RUN_NOT_FOUND",
  "RUN_MISMATCH",
  "ERROR",
];

/**
 * 錯誤碼的標題：已知錯誤碼回傳在地化標題；`HTTP_<status>`（沒有錯誤碼的 HTTP 失敗）回傳「HTTP {status} 錯誤」；
 * 其他回傳 null，由呼叫端改用伺服器原文當標題（不顯示空泛的「錯誤」）。
 */
export function errorHeadline(code: string | null | undefined): string | null {
  if (!code) return null;
  const text = ERROR_TEXTS[code];
  if (text) return text.headline();
  const http = /^HTTP_(\d{3})$/.exec(code);
  return http ? t("HTTP {status} 錯誤", { status: http[1] }) : null;
}

/** Generic next step per registry kind, used when a code has no specific hint. */
const KIND_HINTS: Readonly<Record<ErrorKind, () => string>> = {
  client: () => t("請求內容不被接受：修正後再送出；不會自動重試。"),
  conflict: () => t("與目前狀態衝突：重新讀取、解決衝突後再試。"),
  unavailable: () => t("服務暫時無法使用：稍後再試；不會自動重試。"),
  remote: () => t("遠端結果未知：先確認元件狀態與紀錄，再決定是否重送。"),
  internal: () => t("內部錯誤：查看元件紀錄或服務日誌。"),
};

/** The registry kind of a server code (contracts/error-codes.json); null for client-produced or unknown codes. */
export function errorKind(code: string | null | undefined): ErrorKind | null {
  return code ? (ERROR_CODE_KINDS[code] ?? null) : null;
}

/** The next-step hint for a code: its own hint, else the hint for its kind, else null. */
export function errorHint(code: string | null | undefined): string | null {
  if (!code) return null;
  const own = ERROR_TEXTS[code]?.hint;
  if (own) return own();
  const kind = errorKind(code);
  return kind ? KIND_HINTS[kind]() : null;
}

/** 沒有對照標題、也沒有伺服器訊息時的標題。 */
export function unknownErrorHeadline(code: string): string {
  return t("未知錯誤（{code}）", { code });
}

/** 寫入請求連線中斷或逾時：遠端可能完成也可能沒有（不自動重送）。 */
export function remoteOutcomeUnknownHeadline(): string {
  return t("遠端結果未知");
}
