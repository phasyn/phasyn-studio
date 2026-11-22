// 刪除研究的影響範圍文字（純函式；資料來自 GET …/deletion-preview，與 DELETE 執行後同一形狀）：
// keep_images 保留產生圖片的 run；all 連同此研究獨占的 run 與圖片一起刪；其他研究或 Studio 專案仍在用的一律保留（shared）。
// 有執行中的任務或 run 時主控回報 blocking，不能刪。一次請求完成，沒有背景續刪。
import type { DeleteMode, PromptStudyDeletionPlan } from "../types";
import { t } from "@/i18n";

export const DELETE_MODES: readonly { mode: DeleteMode; label: string; description: string }[] = [
  {
    mode: "keep_images",
    label: t("保留圖片移除"),
    description: t("移除研究、Prompt 版本、任務與比較紀錄；產生圖片的 run 與圖片保留，之後仍可在「紀錄・執行紀錄」找到。"),
  },
  {
    mode: "all",
    label: t("完整移除"),
    description: t("連同這個研究獨占的 run（生成圖片、視覺比較與評分的輸出檔與效能紀錄）一起刪除；其他研究或 Studio 專案仍在使用的保留。"),
  },
];

export function deleteModeLabel(mode: DeleteMode): string {
  return DELETE_MODES.find((item) => item.mode === mode)?.label ?? mode;
}

export type ScopeTone = "neutral" | "warning" | "danger" | "success";
export type ScopeIcon = "document" | "files" | "keep" | "source" | "blocked" | "note" | "irreversible";

export interface ScopeLine {
  icon: ScopeIcon;
  tone: ScopeTone;
  text: string;
}

/** 不能刪的原因（主控的 blocking）；可以刪時為 null。 */
export function deleteBlockReason(plan: PromptStudyDeletionPlan): string | null {
  if (plan.can_delete) return null;
  return plan.blocking[0]?.message ?? t("主控回報目前不能刪除");
}

function count(plan: PromptStudyDeletionPlan, action: PromptStudyDeletionPlan["runs"][number]["action"]): number {
  return plan.runs.filter((row) => row.action === action).length;
}

/** 試算結果 → 確認框列出的影響範圍。 */
export function deleteScopeLines(plan: PromptStudyDeletionPlan, fallbackTitle: string): ScopeLine[] {
  const title = plan.title || fallbackTitle || t("未命名研究");
  const { counts } = plan;
  const lines: ScopeLine[] = [
    {
      icon: "document",
      tone: "neutral",
      text: t("研究「{title}」：{versions} 個版本、{tasks} 個任務、{evaluations} 筆比較、{images} 張生成圖的紀錄會被刪除", { title, versions: counts.versions, tasks: counts.tasks, evaluations: counts.evaluations, images: counts.images }),
    },
  ];
  const files = plan.runs.filter((row) => row.action === "delete").reduce((sum, row) => sum + row.files, 0);
  lines.push(
    counts.runs_delete > 0
      ? { icon: "files", tone: "warning", text: t("刪除 {runs_delete} 個此研究獨占的 run（輸出檔與效能紀錄，共 {files} 個檔案）", { runs_delete: counts.runs_delete, files }) }
      : { icon: "files", tone: "neutral", text: t("不刪除任何 run") },
  );
  const kept = count(plan, "keep");
  const shared = count(plan, "shared");
  const missing = count(plan, "missing");
  if (kept > 0) lines.push({ icon: "keep", tone: "neutral", text: t("保留 {kept} 個產生圖片的 run（圖片仍在 Node 上）", { kept }) });
  if (shared > 0) lines.push({ icon: "keep", tone: "neutral", text: t("保留 {shared} 個仍被其他研究或 Studio 專案使用的 run", { shared }) });
  if (missing > 0) lines.push({ icon: "note", tone: "neutral", text: t("{missing} 個 run 已不存在（視為已刪除）", { missing }) });
  lines.push(
    plan.source.action === "delete"
      ? { icon: "source", tone: "warning", text: t("刪除這個研究獨占、上傳到主控的原圖") }
      : { icon: "source", tone: "neutral", text: t("保留原圖{value}", { value: plan.source.reason ? t("：{reason}", { reason: plan.source.reason }) : "" }) },
  );
  for (const item of plan.blocking) lines.push({ icon: "blocked", tone: "danger", text: item.message || item.code });
  lines.push({ icon: "irreversible", tone: "danger", text: t("無法復原；只想先收起來請改用「封存」") });
  return lines;
}

/** 刪除完成（或中途停止）後的結果文字。 */
export function deleteResultLines(plan: PromptStudyDeletionPlan): ScopeLine[] {
  const deleted = plan.runs.filter((row) => row.status === "deleted").length;
  const missing = plan.runs.filter((row) => row.status === "missing").length;
  const failed = plan.runs.filter((row) => row.status === "failed");
  const lines: ScopeLine[] = [{ icon: "document", tone: plan.deleted ? "success" : "danger", text: plan.deleted ? t("研究已刪除") : t("研究沒有刪除") }];
  if (deleted > 0 || missing > 0) lines.push({ icon: "files", tone: "success", text: t("已刪除 {deleted} 個 run{value}", { deleted, value: missing > 0 ? t("（{missing} 個原本就不在）", { missing }) : "" }) });
  for (const row of failed) lines.push({ icon: "blocked", tone: "danger", text: t("run {run_id} 沒有刪除：{value}", { run_id: row.run_id.slice(0, 8), value: row.message ?? t("原因未知") }) });
  if (plan.source.status === "deleted") lines.push({ icon: "source", tone: "success", text: t("原圖已刪除") });
  else if (plan.source.status === "failed") lines.push({ icon: "source", tone: "danger", text: t("原圖沒有刪除") });
  return lines;
}
