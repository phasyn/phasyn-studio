// 「推理 Studio」左欄資源樹：反推（語意與資料集，首頁）、圖片反推、手動執行（已保存的元件組合）。
import { Play, ScanSearch, ScanText, Workflow } from "lucide-react";
import type { WirePipeline } from "@/api/types";
import { inferencePath, PATHS } from "@/app/paths";
import type { AreaSection } from "@/app/layout/AreaLayout";
import type { TreeItem } from "@/components/workbench/treeModel";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const INFERENCE_SECTIONS: readonly AreaSection[] = [
  { id: "semantics", path: PATHS.semantics, label: t("反推（語意與資料集）"), icon: ScanText, hint: t("影片反推：原片 → Scene → caption → 資料集匯出") },
  { id: "prompt-studies", path: PATHS.promptStudies, label: t("圖片反推"), icon: ScanSearch, hint: t("從一張圖反推 8 區段場景與 core／detailed prompt；生成比對與有界搜尋") },
  { id: "run", path: PATHS.inferenceRun, label: t("手動執行"), icon: Play, hint: t("選一個元件組合，上傳輸入後建立 run") },
];

export const inferenceSectionId = (id: string) => `section:${id}`;
export const inferencePipelineId = (pipelineId: string) => `pipeline:${pipelineId}`;

export interface InferenceTreeInput {
  pipelines: readonly WirePipeline[] | undefined;
  status: "pending" | "error" | "ready";
}

const KEYWORDS: Record<string, readonly string[]> = {
  semantics: ["semantics", "dataset", "caption", "scene", "describe", t("影片反推")],
  "prompt-studies": ["prompt", "study", "image", "vision", "qwen-image", "scene"],
  run: ["inference", "pipeline", "run", "upload", t("執行元件組合")],
};

export function buildInferenceTree(input: InferenceTreeInput): TreeItem[] {
  return INFERENCE_SECTIONS.map((section) => {
    const base: TreeItem = { id: inferenceSectionId(section.id), label: section.label, icon: section.icon, to: section.path, title: section.hint, keywords: KEYWORDS[section.id] };
    if (section.id !== "run") return base;
    if (!input.pipelines) return { ...base, detail: input.status === "error" ? t("讀取失敗") : t("讀取中…") };
    return {
      ...base,
      count: input.pipelines.length,
      children: input.pipelines.map((pipeline) => ({
        id: inferencePipelineId(pipeline.pipeline_id),
        label: pipeline.label || pipeline.pipeline_id,
        icon: Workflow,
        to: inferencePath({ pipeline: pipeline.pipeline_id }),
        title: t("{value}\n{pipeline_id} · {stepsCount} 個步驟 · 輸入：{value2}", { value: pipeline.label || pipeline.pipeline_id, pipeline_id: pipeline.pipeline_id, stepsCount: pipeline.steps.length, value2: formatList(pipeline.inputs.map((port) => port.name)) || t("無") }),
        detail: t("{stepsCount} 步", { stepsCount: pipeline.steps.length }),
        keywords: [pipeline.pipeline_id, ...pipeline.inputs.map((port) => port.type_id)],
      })),
    };
  });
}

/** 依網址決定選取的樹項目：/inference/run?pipeline=x → 該元件組合（樹上沒有時退回「手動執行」）；其他頁面 → 該頁。 */
export function inferenceSelection(pathname: string, search: URLSearchParams): string[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "inference") return [];
  const page = parts[1];
  if (page === undefined) return [inferenceSectionId("semantics")]; // 入口：正在導向首頁
  if (page === "semantics" || page === "prompt-studies") return [inferenceSectionId(page)];
  if (page !== "run") return [];
  const pipeline = search.get("pipeline");
  return pipeline ? [inferencePipelineId(pipeline), inferenceSectionId("run")] : [inferenceSectionId("run")];
}

export const INFERENCE_DEFAULT_EXPANDED: readonly string[] = [inferenceSectionId("run")];
