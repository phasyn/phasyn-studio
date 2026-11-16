// 鏡頭目前能不能渲染（屬性面板的「渲染鏡頭」與監看器的「渲染這個鏡頭」共用同一套判斷，兩處一致地停用並說明原因）。
// 有 DiT 分流時，鏡頭的元件組合若是未就緒的分流元件組合，改用就緒的那條檢查（送出時會移到就緒的元件組合）。
import type { StudioShot } from "@/api/generated/contracts";
import { useProjectLanes } from "../model/lanePrefs";
import { laneRouteFor } from "../model/lanes";
import { shotStatus } from "../model/project";
import { renderProblem, type RenderProblem } from "../model/renderPlan";
import { engineUnavailable } from "../model/routes";
import { useStudio } from "../studioContext";
import { t } from "@/i18n";

export interface RenderBlock {
  /** prompt 空白、鏡頭渲染中、主控正在跑別的 run。 */
  problem: string | null;
  /** 送出前檢查（元件組合、插件、prompt、參考素材、首幀接續…）沒過的原因與該去哪裡修；與實際送出時同一套 planRender。 */
  preflight: RenderProblem | null;
}

/** 渲染引擎還不能用（讀取中、讀不到）時的原因，當成 engine 類的送出前問題。 */
export function engineBlock(text: string | null): RenderProblem | null {
  return text === null ? null : { kind: "engine", text, items: [] };
}

export function useRenderBlock(shot: StudioShot): RenderBlock {
  const { project, engine, catalog, plugins, runBlockedReason } = useStudio();
  const lanes = useProjectLanes(project.project_id);
  if (!shot.prompt.trim()) return { problem: t("先在「Prompt」分頁輸入 prompt"), preflight: null };
  if (shotStatus(shot, project) === "rendering") return { problem: t("這個鏡頭正在渲染"), preflight: null };
  if (runBlockedReason) return { problem: runBlockedReason, preflight: null };
  const route = laneRouteFor(engine.routes, lanes, shot);
  return { problem: null, preflight: engineBlock(engineUnavailable(engine)) ?? renderProblem(project, { ...shot, route }, { routes: engine.routes, catalog, plugins }) };
}

/** 按鈕的停用原因：先看鏡頭本身與送出前檢查，再看是否正在送出其他請求（送出渲染中的按鈕顯示進行中，不另外停用）。 */
export function renderDisabledReason(block: RenderBlock, busy: "render" | "export" | null | undefined): string | null {
  const busyReason = busy === "export" ? t("正在送出匯出請求") : busy === "render" ? t("正在送出渲染請求") : null;
  return block.problem ?? block.preflight?.text ?? (busy === "render" ? null : busyReason);
}
