import type { StudioDraftPlan } from "@/api/generated/contracts";
import { t } from "@/i18n";
function planStates() {
  return {
    planned: t("待核准"),
    running: t("執行中"),
    stopping: t("停止中"),
    completed: t("已完成"),
    cancelled: t("已取消"),
    expired: t("期限已到"),
    uncertain: t("等待查證"),
    budget_exhausted: t("已用完預算"),
  };
}
export function planStatus(s: StudioDraftPlan["status"]) {
  return planStates()[s];
}
