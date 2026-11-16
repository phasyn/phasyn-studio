import { BrainCircuit } from "lucide-react";
import { useLocation } from "react-router";
import { usePipelines } from "@/api/pipelines";
import { AreaExplorer, AreaLayout, AreaRail } from "@/app/layout/AreaLayout";
import { buildInferenceTree, INFERENCE_DEFAULT_EXPANDED, INFERENCE_SECTIONS, inferenceSelection } from "./inferenceTree";
import { t } from "@/i18n";

/** 「推理 Studio」左欄：反推（首頁）、圖片反推、手動執行（已保存的元件組合，GET /api/pipelines）。 */
function InferenceExplorer({ onCollapse }: { onCollapse: () => void }) {
  const location = useLocation();
  const pipelines = usePipelines();
  const items = buildInferenceTree({
    pipelines: pipelines.data?.items,
    status: pipelines.data ? "ready" : pipelines.isError ? "error" : "pending",
  });
  return (
    <AreaExplorer
      title={t("推理 Studio")}
      label={t("推理 Studio 導覽")}
      icon={<BrainCircuit aria-hidden />}
      items={items}
      candidates={inferenceSelection(location.pathname, new URLSearchParams(location.search))}
      storageKey="inference.tree"
      defaultExpanded={INFERENCE_DEFAULT_EXPANDED}
      searchPlaceholder={t("搜尋頁面、元件組合、輸入型別…")}
      onCollapse={onCollapse}
      footer={pipelines.isError ? (pipelines.data ? t("元件組合列表更新失敗：顯示上一次的資料") : t("無法讀取元件組合列表")) : null}
    />
  );
}

/** 推理 Studio：/inference/semantics（反推，首頁）、/inference/prompt-studies（圖片反推）、/inference/run（手動執行）。 */
export function InferenceLayout() {
  return (
    <AreaLayout
      area="inference"
      explorer={(collapse) => <InferenceExplorer onCollapse={collapse} />}
      rail={(expand) => <AreaRail label={t("推理 Studio 導覽")} title={t("推理 Studio")} sections={INFERENCE_SECTIONS} onExpand={expand} />}
    />
  );
}
