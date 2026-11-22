// 讀回渲染結果：專案中狀態為 rendering 的 take／匯出，各自輪詢它的 run；分支一完成就更新 take（批次 run
// 仍在跑時，已完成的鏡頭會先變成可用）。這只是讀取 run，不重送、不恢復任何工作。
import { t } from "@/i18n";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { StudioProject } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { runQueryOptions } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { continuityTakeOutcome } from "../model/continuity";
import { exportOutcome } from "../model/pipelines";
import { runsInProgress, type ProjectAction } from "../model/project";

/** 還在渲染的 take／匯出所屬的 run（每個 run 一次）。 */
export function pendingRunIds(project: StudioProject): string[] {
  return [...new Set([...runsInProgress(project), ...(project.timeline?.sources.flatMap((source) => (source.proxy_run_id != null && source.proxy_run_id !== "") && !source.proxy && !(source.proxy_error != null && source.proxy_error !== "") ? [source.proxy_run_id] : []) ?? [])])];
}

/** 從執行紀錄讀回結果；套用時由 reducer 依當下的選片決定首個成功 Take。 */
export function reconcileActions(project: StudioProject, run: WireRun): ProjectAction[] {
  const actions: ProjectAction[] = [];
  for (const shot of project.shots) {
    for (const take of shot.takes) {
      if (take.run_id !== run.run_id || take.state !== "rendering") continue;
      const outcome = continuityTakeOutcome(run, take);
      if (outcome.state === "rendering") continue;
      actions.push({ type: "updateTake", runId: run.run_id, outputKey: take.output_key, patch: outcome, activateOnSuccess: true });
    }
  }
  for (const record of project.exports) {
    if (record.run_id !== run.run_id || record.state !== "rendering") continue;
    const outcome = exportOutcome(run);
    if (outcome.state === "rendering") continue;
    actions.push({ type: "updateExport", runId: run.run_id, patch: outcome });
  }
  for (const source of project.timeline?.sources ?? []) {
    if (source.proxy_run_id !== run.run_id || source.proxy || (source.proxy_error != null && source.proxy_error !== "")) continue;
    const outcome = exportOutcome(run);
    if (outcome.state === "rendering") continue;
    const asset = outcome.asset;
    const valid = asset?.complete === true && asset.frame_count === source.duration_frames && asset.fps?.num === project.timeline?.fps.num && asset.fps?.den === project.timeline?.fps.den && source.file?.sha256 === source.proxy_source_sha256;
    actions.push({ type: "patchTimelineSource", sourceId: source.source_id, patch: valid ? { proxy: asset } : { proxy_error: outcome.error?.message ?? t("代理媒體的影格數、時間基準或原始來源不符") } });
  }
  return actions;
}

/** Every cost-profile query (any component): a finished run adds recordings, so the time estimates read them again. */
const COST_PROFILES = qk.costProfilesAll();

export function useRenderTracker(project: StudioProject, dispatch: (action: ProjectAction) => void): WireRun[] {
  const client = useQueryClient();
  const ids = useMemo(() => pendingRunIds(project), [project]);
  const runs = useQueries({
    queries: ids.map((runId) => runQueryOptions(runId)),
    // 結構共享：資料沒變時回傳同一個陣列，effect 不會每次 render 都跑
    combine: (results) => results.flatMap((result) => (result.data ? [result.data] : [])),
  });

  // reconcile 只對仍是 rendering 的 take／匯出產生動作，套用後就不再產生，所以重跑是冪等的。
  // 結束的 run（成功或失敗；記憶體不足的失敗也會更新風險門檻）讓耗時預估重新讀取成本檔案。
  useEffect(() => {
    let ended = false;
    for (const run of runs) {
      const actions = reconcileActions(project, run);
      for (const action of actions) dispatch(action);
      if (actions.length > 0 && run.state !== "running") ended = true;
    }
    if (ended) void client.invalidateQueries({ queryKey: COST_PROFILES });
  }, [runs, project, dispatch, client]);

  return runs;
}
