import { optionalField } from "@/lib/json";
// 「紀錄」左欄資源樹：執行紀錄（近期 run 子樹）、效能紀錄、比較、追蹤設定、儲存空間。計數只用已在快取中的資料（不另外發請求）。
import { Gauge, GitCompareArrows, HardDrive, ListVideo, ScrollText } from "lucide-react";
import type { WireRun } from "@/api/types";
import { PATHS, runPath } from "@/app/paths";
import { statusSpec } from "@/components/common/statusSpec";
import type { AreaSection } from "@/app/layout/AreaLayout";
import type { TreeItem } from "@/components/workbench/treeModel";
import { runDisplayName } from "@/lib/runName";
import { t } from "@/i18n";

export const RECORDS_SECTIONS: readonly AreaSection[] = [
  { id: "runs", path: PATHS.runs, label: t("執行紀錄"), icon: ListVideo, hint: t("所有 run 的狀態、輸出與錯誤") },
  { id: "recordings", path: PATHS.recordings, label: t("效能紀錄"), icon: ScrollText, hint: t("load／invoke 的量測、事件與匯出") },
  { id: "comparisons", path: PATHS.comparisons, label: t("比較"), icon: GitCompareArrows, hint: t("recording 的設定差異與指標") },
  { id: "tracking", path: PATHS.tracking, label: t("追蹤設定"), icon: Gauge, hint: t("各元件的 recorder 模式、取樣與 trace") },
  { id: "storage", path: PATHS.storage, label: t("儲存空間"), icon: HardDrive, hint: t("磁碟用量、清理沒有引用的 run 與檔案、固定要保留的項目") },
];

/** 樹上列出的近期 run 數（完整清單在執行紀錄頁）。 */
export const TREE_RUN_LIMIT = 8;

export interface RecordsTreeInput {
  /** run 列表第一頁（新到舊）；undefined＝尚未讀到。 */
  runs: readonly WireRun[] | undefined;
  /** 第一頁之後還有更多 run（計數只能顯示「至少」）。 */
  moreRuns: boolean;
  /** 「加入比較」清單中的 recording 數。 */
  compareCount: number;
  /** 目錄中的元件 instance 數；undefined＝目錄尚未讀到。 */
  componentCount: number | undefined;
  /** recorder 降級（recorder_state=degraded）的元件數。 */
  degradedCount: number;
}

export const sectionTreeId = (id: string) => `section:${id}`;
export const runTreeId = (runId: string) => `run:${runId}`;

/**
 * Video Studio 的 run 名稱是「Studio：專案・鏡頭」、Image Studio 的是「Image Studio：專案・圖片」：樹上先顯示最後一段
 * （鏡頭、圖片或動作），完整名稱在 tooltip。
 */
export function runTreeLabel(label: string): string {
  // run 名稱存在伺服器上：前綴與「・」是固定格式（各語言的譯文都保留它們），比對時不翻譯。
  if (!label.startsWith("Studio：") && !label.startsWith("Image Studio：")) return label; // i18n-ignore
  const parts = label.split("・"); // i18n-ignore
  return parts.length > 1 ? (parts[parts.length - 1] ?? label) : label;
}

function clockLabel(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function runItem(run: WireRun): TreeItem {
  const state = statusSpec("run", run.state);
  const label = runDisplayName(run);
  return {
    id: runTreeId(run.run_id),
    label: runTreeLabel(label),
    ...optionalField("detail", clockLabel(run.created_at)),
    icon: ListVideo,
    to: runPath(run.run_id),
    title: `${label}\n${run.run_id} · ${state.label}`,
    dot: state.tone,
    dotLabel: state.label,
    keywords: [run.run_id, run.request.pipeline.pipeline_id],
  };
}

export function buildRecordsTree(input: RecordsTreeInput): TreeItem[] {
  return RECORDS_SECTIONS.map((section) => {
    const base = { id: sectionTreeId(section.id), label: section.label, icon: section.icon, to: section.path, title: section.hint };
    if (section.id === "runs") {
      if (!input.runs) return base;
      const running = input.runs.filter((run) => run.state === "running").length;
      return {
        ...base,
        // 只有一頁時是確切總數；還有下一頁時只標「至少 N」，不冒充總數。
        ...(input.moreRuns ? { detail: `${String(input.runs.length)}+`, title: t("{hint}\n已載入最近 {runsCount} 個（還有更多）", { hint: section.hint, runsCount: input.runs.length }) } : { count: input.runs.length }),
        dot: running > 0 ? "info" : null,
        ...(running > 0 ? { dotLabel: t("{running} 個執行中", { running }) } : {}),
        children: input.runs.slice(0, TREE_RUN_LIMIT).map(runItem),
      };
    }
    if (section.id === "comparisons") {
      return input.compareCount > 0 ? { ...base, count: input.compareCount, title: t("{hint}\n比較清單中有 {compareCount} 筆 recording", { hint: section.hint, compareCount: input.compareCount }) } : base;
    }
    if (section.id === "tracking") {
      if (input.componentCount === undefined) return base;
      return {
        ...base,
        count: input.componentCount,
        dot: input.degradedCount > 0 ? "warning" : null,
        ...(input.degradedCount > 0 ? { dotLabel: t("{degradedCount} 個元件紀錄降級", { degradedCount: input.degradedCount }) } : {}),
      };
    }
    return base;
  });
}

/** 依目前網址決定選取的樹項目：先找具體物件（run），樹上沒有時退回所在頁面。 */
export function recordsSelection(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "records") return [];
  const page = parts[1] ?? "runs";
  const candidates: string[] = [];
  if (page === "runs" && (parts[2] != null && parts[2] !== "")) candidates.push(runTreeId(decodeSafe(parts[2])));
  candidates.push(sectionTreeId(page));
  return candidates;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const RECORDS_DEFAULT_EXPANDED: readonly string[] = [sectionTreeId("runs")];
