// Live progress of the take being rendered: reads only the run cache the render tracker already polls and the
// per-step event cache that RenderActivityProvider keeps fresh while the run renders (no new requests).
import { useMemo } from "react";
import type { StudioTake } from "@/api/generated/contracts";
import { useCachedRun } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { useRunProgress } from "../../hooks/useRunProgress";
import { branchSuffix } from "../../model/pipelines";
import { type BranchView, catalogLookup, type ProviderLookup } from "../../model/progress";
import { useStudio } from "../../studioContext";

export interface TakeRender {
  run: WireRun | undefined;
  views: readonly BranchView[];
  view: BranchView | null;
  /** DiT 去噪的實測比例（0–1）；沒有逐步證據時 null（不畫假的進度）。 */
  fraction: number | null;
  lookup: ProviderLookup;
}

/**
 * 正在渲染的 take 的進度：run 由 render tracker 輪詢（這裡 enabled: false，只讀快取）；DiT 逐步事件也只讀快取（poll: false），
 * 由 RenderActivityProvider 在這個專案的 run 執行期間輪詢。不發任何新的請求。
 */
export function useTakeRender(take: StudioTake | null): TakeRender {
  const { catalog } = useStudio();
  const lookup = useMemo(() => catalogLookup(catalog), [catalog]);
  const runId = take?.run_id ?? "";
  const cached = useCachedRun(runId).data;
  const run = take ? cached : undefined;
  const progress = useRunProgress(run, { poll: false, lookup });
  const suffix = take ? branchSuffix(take.output_key) : "";
  const view = progress.views.find((item) => item.suffix === suffix) ?? null;
  const fraction = view?.state === "running" ? view.progress.fraction : null;
  return { run, views: progress.views, view, fraction, lookup };
}
