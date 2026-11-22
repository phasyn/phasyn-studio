// 推理 Studio・LoRA 訓練：沒有 ?training= 時是訓練工作清單（含「新增訓練」），有時開啟那個工作的工作區。
// 路由 /inference/training（handle { frame: "self" }）；頁面只看 search 切換。
import { useSearchParams } from "react-router";
import { SubBrandNav } from "@/components/flow/SubBrandNav";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { t } from "@/i18n";
import { TrainingList } from "./TrainingList";
import { TrainingWorkspace } from "./TrainingWorkspace";

export function TrainingPage() {
  const [params] = useSearchParams();
  const id = params.get("training");
  const center = (
    <>
      <SubBrandNav current="training" />
      {id != null && id !== "" ? <TrainingWorkspace key={id} trainingId={id} /> : <TrainingList />}
    </>
  );
  return <WorkbenchPage storageKey="inference.training" centerLabel={t("LoRA 訓練工作區")} center={center} />;
}
