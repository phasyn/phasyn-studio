// 插件包的問題（契約 StudioPluginIssue）：安裝被拒絕的原因、不相容或損壞的原因、登錄表層級的問題。
// code 是穩定的識別字：介面對常見的 code 有自己的說法（能帶上 details 裡的數字與名稱）；其餘顯示主控的固定說明
// （message，有譯文時顯示譯文）。path 是包內的相對路徑或 manifest 內的位置，從不是主機上的路徑。
import type { StudioPluginIssue } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { t, tServer } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { isRecord } from "@/lib/json";

type Details = StudioPluginIssue["details"];

function word(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function size(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? formatBytes(value) : null;
}

/** 有 details 可用時的說法；回傳 null＝改用主控的固定說明。 */
const ISSUE_TEXTS: Readonly<Record<string, (details: Details) => string | null>> = {
  code_unsupported: () => t("這個版本還不能執行程式碼"),
  host_version: (details) => {
    const required = word(details.required);
    const host = word(details.host);
    return required && host ? t("需要 Phasyn Studio {required}，這台主控是 {host}", { required, host }) : null;
  },
  permission_unknown: (details) => {
    const permission = word(details.permission);
    return permission ? t("要求了這個版本不認得的權限「{permission}」", { permission }) : null;
  },
  permission_reserved: (details) => {
    const permission = word(details.permission);
    return permission ? t("要求了保留、不開放的權限「{permission}」", { permission }) : null;
  },
  preset_rule_missing: (details) => {
    const preset = word(details.preset);
    const rule = word(details.rule);
    return preset && rule ? t("推薦組合「{preset}」引用了找不到的規則「{rule}」", { preset, rule }) : null;
  },
  file_too_large: (details) => {
    const actual = size(details.size);
    const limit = size(details.limit);
    return actual && limit ? t("檔案 {actual}，超過上限 {limit}", { actual, limit }) : null;
  },
  total_too_large: (details) => {
    const actual = size(details.size);
    const limit = size(details.limit);
    return actual && limit ? t("解壓後合計 {actual}，超過上限 {limit}", { actual, limit }) : null;
  },
  too_many_files: (details) => {
    const limit = word(details.limit);
    return limit ? t("檔案數量超過上限 {limit} 個", { limit }) : null;
  },
  ratio_too_high: (details) => {
    const limit = word(details.limit);
    return limit ? t("壓縮比超過上限 {limit}:1", { limit }) : null;
  },
  duplicate_id: (details) => {
    const id = word(details.id);
    return id ? t("同一個包內的 id「{id}」重複", { id }) : null;
  },
  frames_invalid: (details) => {
    const frames = word(details.frames);
    return frames ? t("影格數 {frames} 不是 17n+5", { frames }) : null;
  },
  dev_dir_conflict: (details) => {
    const id = word(details.plugin_id);
    return id ? t("開發目錄的插件 id「{id}」與另一個已載入的插件相同", { id }) : null;
  },
  manifest_invalid: (details) => {
    const reason = word(details.reason);
    return reason ? t("plugin.json 不符合 manifest 契約：{reason}", { reason }) : null;
  },
};

/** 一個問題的說明（已翻譯）。 */
export function issueText(issue: StudioPluginIssue): string {
  return ISSUE_TEXTS[issue.code]?.(issue.details) ?? tServer(issue.message);
}

function isIssue(value: unknown): value is StudioPluginIssue {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

function toIssue(value: StudioPluginIssue): StudioPluginIssue {
  return { code: value.code, message: value.message, path: typeof value.path === "string" ? value.path : null, details: isRecord(value.details) ? value.details : {} };
}

/** 任意值裡的問題清單（不是清單時為空；形狀不對的項目略過）。 */
export function readIssues(value: unknown): StudioPluginIssue[] {
  return Array.isArray(value) ? value.filter(isIssue).map(toIssue) : [];
}

export interface InstallFailure {
  /** 主控列出的問題（422 STUDIO_PLUGIN_INVALID 的 details.errors，最多 20 項）。 */
  issues: StudioPluginIssue[];
  /** 主控只列出前面的問題，還有沒列出的（details.truncated）。 */
  truncated: boolean;
}

/** 安裝被拒絕時主控列出的問題；不是這種錯誤時 issues 為空。 */
export function installFailure(error: unknown): InstallFailure {
  if (!isApiError(error)) return { issues: [], truncated: false };
  return { issues: readIssues(error.details.errors), truncated: error.details.truncated === true };
}
