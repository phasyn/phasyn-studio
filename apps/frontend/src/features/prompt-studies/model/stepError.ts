// Errors the prompt-study runner finds itself (no server answer involved) are kept in the study document as an error
// code plus structured parameters (details.text) and worded when shown, so they read in the viewer's language. A
// server's error keeps its own message, shown through tServer. Sub-lines produced by form and schema checks
// (settingsProblems, route problems, lib/schema issues) are stored as they were worded; their wording belongs to those
// modules. Anything else (another tool's error, an unknown shape) is shown as it is; reading never throws. Pure.
import type { ApiErrorBody } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { t, tServer } from "@/i18n";
import { formatList } from "@/i18n/format";

export type ComponentRole = "vision" | "compile" | "score";
export type ResultOutput = "caption" | "scene" | "candidates" | "revised_scene" | "comparison" | "score" | "pairwise" | "confirmation";

export interface ParameterIssue {
  path: string;
  /** As lib/schema worded it when the check ran. */
  message: string;
}

export type StepErrorText =
  | { kind: "run_not_found"; run_id: string }
  | { kind: "run_mismatch"; pipeline_id: string; expected: string }
  | { kind: "run_ended"; state: "failed" | "cancelled" | "interrupted" }
  | { kind: "component_missing"; role: ComponentRole; component: string | null }
  | { kind: "interface_mismatch"; component_id: string; provider_id: string; inputs: string[]; outputs: string[] }
  | { kind: "params_rejected"; component_id: string; name: string | null; issues: ParameterIssue[] }
  | { kind: "base_version_missing" }
  | { kind: "frozen_base_missing" }
  | { kind: "settings_unreadable" }
  | { kind: "route_missing"; route: string }
  | { kind: "route_unusable"; label: string; problems: string[] }
  | { kind: "settings_invalid"; problems: string[] }
  | { kind: "prompt_empty" }
  | { kind: "no_prompt_input" }
  | { kind: "no_negative_input"; label: string }
  | { kind: "output_missing"; output: ResultOutput }
  | { kind: "image_missing" };

/** Marks details.text as one of these (and its version). */
const FORMAT = "phasyn.prompt-study.step-error/1";
const ROLES: readonly ComponentRole[] = ["vision", "compile", "score"];
const OUTPUTS: readonly ResultOutput[] = ["caption", "scene", "candidates", "revised_scene", "comparison", "score", "pairwise", "confirmation"];
const RUN_STATES = ["failed", "cancelled", "interrupted"] as const;

function roleText(role: ComponentRole): string {
  switch (role) {
    case "vision":
      return t("視覺模型");
    case "compile":
      return t("編譯");
    case "score":
      return t("評分");
  }
}

function outputText(output: ResultOutput): string {
  switch (output) {
    case "caption":
      return t("原圖描述");
    case "scene":
      return t("場景");
    case "candidates":
      return t("編譯結果（core／detailed）");
    case "revised_scene":
      return t("修訂後的場景");
    case "comparison":
      return t("比較結果");
    case "score":
      return t("評分結果");
    case "pairwise":
      return t("雙順序比較結果");
    case "confirmation":
      return t("確認結果");
  }
}

function issueLines(issues: readonly ParameterIssue[]): string {
  return issues.map((issue) => `${issue.path || t("（根）")} ${issue.message}`).join(t("；"));
}

/** The error in the current language. */
export function stepErrorWords(text: StepErrorText): string {
  switch (text.kind) {
    case "run_not_found":
      return t("run {runId} 已不存在（可能已被刪除）", { runId: text.run_id });
    case "run_mismatch":
      return t("最後一個 run（{pipeline_id}）不是這一步的 {expected}；需要重新執行這一步", { pipeline_id: text.pipeline_id, expected: text.expected });
    case "run_ended":
      return text.state === "cancelled" ? t("run 已取消") : text.state === "interrupted" ? t("run 已中斷") : t("run 失敗");
    case "component_missing":
      return t("{role}元件 {value} 不在目錄中：到「元件修改」確認後重試", { role: roleText(text.role), value: text.component ?? t("（未選擇）") });
    case "interface_mismatch":
      return t("元件 {component_id}（{provider_id}）沒有{value}：介面與本頁預期不同", {
        component_id: text.component_id,
        provider_id: text.provider_id,
        value: formatList([...text.inputs.map((name) => t("輸入「{name}」", { name })), ...text.outputs.map((name) => t("輸出「{name}」", { name }))]),
      });
    case "params_rejected":
      return (text.name != null && text.name !== "")
        ? t("{name}（{component_id}）不接受這組參數：{map}", { name: text.name, component_id: text.component_id, map: issueLines(text.issues) })
        : t("元件 {component_id} 不接受這組參數：{map}", { component_id: text.component_id, map: issueLines(text.issues) });
    case "base_version_missing":
      return t("找不到修訂的起點版本");
    case "frozen_base_missing":
      return t("找不到任務的起點版本（凍結的評分場景）");
    case "settings_unreadable":
      return t("任務的生成設定無法解讀");
    case "route_missing":
      return t("找不到元件組合 {route}（可能已刪除）", { route: text.route });
    case "route_unusable":
      return t("元件組合「{label}」不能用：{problems}", { label: text.label, problems: text.problems.join(t("；")) });
    case "settings_invalid":
      return text.problems.join(t("；"));
    case "prompt_empty":
      return t("prompt 是空的");
    case "no_prompt_input":
      return t("元件組合沒有 prompt 輸入");
    case "no_negative_input":
      return t("元件組合「{label}」沒有負面提示詞輸入：清空負面提示詞，或改用有 negative_prompt 輸入的元件組合", { label: text.label });
    case "output_missing":
      return t("run 成功但沒有可解讀的{what}（輸出與本頁預期不同）", { what: outputText(text.output) });
    case "image_missing":
      return t("生成 run 成功，但沒有 image／image_white 輸出");
  }
}

/** details.text for an error the runner found. */
export function stepErrorDetails(text: StepErrorText): { text: Record<string, unknown> } {
  return { text: { format: FORMAT, ...text } };
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const isLines = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function readIssues(value: unknown): ParameterIssue[] | null {
  if (!Array.isArray(value)) return null;
  const issues: ParameterIssue[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item["path"] !== "string" || typeof item["message"] !== "string") return null;
    issues.push({ path: item["path"], message: item["message"] });
  }
  return issues;
}

/** The structured error details.text holds, or null when it holds anything else. */
export function readStepErrorText(value: unknown): StepErrorText | null {
  if (!isRecord(value) || value["format"] !== FORMAT) return null;
  switch (value["kind"]) {
    case "run_not_found":
      return isId(value["run_id"]) ? { kind: "run_not_found", run_id: value["run_id"] } : null;
    case "run_mismatch":
      return isId(value["pipeline_id"]) && isId(value["expected"]) ? { kind: "run_mismatch", pipeline_id: value["pipeline_id"], expected: value["expected"] } : null;
    case "run_ended":
      return oneOf(RUN_STATES, value["state"]) ? { kind: "run_ended", state: value["state"] } : null;
    case "component_missing":
      return oneOf(ROLES, value["role"]) && (value["component"] === null || isId(value["component"])) ? { kind: "component_missing", role: value["role"], component: value["component"] } : null;
    case "interface_mismatch":
      return isId(value["component_id"]) && isId(value["provider_id"]) && isLines(value["inputs"]) && isLines(value["outputs"])
        ? { kind: "interface_mismatch", component_id: value["component_id"], provider_id: value["provider_id"], inputs: value["inputs"], outputs: value["outputs"] }
        : null;
    case "params_rejected": {
      const issues = readIssues(value["issues"]);
      return isId(value["component_id"]) && (value["name"] === null || isId(value["name"])) && issues ? { kind: "params_rejected", component_id: value["component_id"], name: value["name"], issues } : null;
    }
    case "route_missing":
      return isId(value["route"]) ? { kind: "route_missing", route: value["route"] } : null;
    case "route_unusable":
      return typeof value["label"] === "string" && isLines(value["problems"]) ? { kind: "route_unusable", label: value["label"], problems: value["problems"] } : null;
    case "settings_invalid":
      return isLines(value["problems"]) ? { kind: "settings_invalid", problems: value["problems"] } : null;
    case "no_negative_input":
      return typeof value["label"] === "string" ? { kind: "no_negative_input", label: value["label"] } : null;
    case "output_missing":
      return oneOf(OUTPUTS, value["output"]) ? { kind: "output_missing", output: value["output"] } : null;
    case "base_version_missing":
    case "frozen_base_missing":
    case "settings_unreadable":
    case "prompt_empty":
    case "no_prompt_input":
    case "image_missing":
      return { kind: value["kind"] };
    default:
      return null;
  }
}

/**
 * A stored step error for people: the runner's own errors are worded now, in the current language; a server's message
 * goes through tServer; anything else is shown as it is ("" when there is no message, so the code stands alone).
 */
export function stepErrorText(error: Pick<ApiErrorBody, "message" | "details"> | null | undefined): string {
  if (!error) return "";
  const text = readStepErrorText(error.details?.["text"]);
  return text ? stepErrorWords(text) : tServer(error.message);
}
