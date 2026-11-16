// 讀回生成結果：專案中還在生成的 take 各自輪詢它的 run（同一個批次一個 run），一張完成就更新那一張；
// 中間預覽與進度也從同一份 run 狀態讀（不另外輪詢）。只讀 run，不重送、不恢復任何工作。
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { runQueryOptions } from "@/api/runs";
import type { WireRun } from "@/api/types";
import type { ImageProjectAction } from "../model/project";
import { reconcileImageActions } from "../model/reconcile";
import { imageRunsInProgress } from "../model/shots";
import type { ImageStudioProject } from "../types";

export function useImageRunTracker(project: ImageStudioProject, dispatch: (action: ImageProjectAction) => void): ReadonlyMap<string, WireRun> {
  const ids = useMemo(() => imageRunsInProgress(project), [project]);
  const runs = useQueries({
    queries: ids.map((runId) => runQueryOptions(runId)),
    combine: (results) => results.flatMap((result) => (result.data ? [result.data] : [])),
  });

  // reconcile 只對仍是 rendering 的 take 產生動作，套用後就不再產生，所以重跑是冪等的
  useEffect(() => {
    const now = new Date().toISOString();
    for (const run of runs) for (const action of reconcileImageActions(project, run, now)) dispatch(action);
  }, [runs, project, dispatch]);

  return useMemo(() => new Map(runs.map((run) => [run.run_id, run])), [runs]);
}
