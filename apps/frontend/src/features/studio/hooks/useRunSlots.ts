// The Controller's run slots, for Video Studio and Image Studio: the runs executing now (useActiveRuns: the shared run list, one poll app-wide) against how many runs the Controller executes at
// once (GET /api/controller max_active_runs). Rendering is blocked only when every slot is taken; while the limit is
// unknown one slot is assumed, as before the Controller reported it, and the reason says so. A slot is taken only by a
// run that computes (one of its steps runs): a run that only waits for a busy GPU and a proxy rendition take none, the
// same rule as the Controller's runner (CPU-only fixes are not blocked by queued GPU renders).
import { useMemo } from "react";
import { useController } from "@/api/controller";
import { useActiveRuns } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";
import { runDisplayName } from "@/lib/runName";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface RunSlots {
  /** The runs executing now (state running), newest first; ids only, the run documents stay in the query cache. */
  activeRunIds: readonly string[];
  /** max_active_runs of the Controller; null while it is not read (one slot is assumed then). */
  limit: number | null;
  /** Why a new run would be refused (every slot taken); null when one can start. */
  blockedReason: string | null;
}

/** The run holds one of the Controller's slots: not a proxy rendition, and one of its steps is running. */
export function takesRunSlot(run: Pick<WireRun, "request" | "steps">): boolean {
  if (run.request.purpose === "proxy") return false;
  return Object.values(run.steps).some((step) => isRecord(step) && step["state"] === "running");
}

export function runSlots(running: readonly WireRun[], limit: number | null): RunSlots {
  const activeRunIds = running.map((run) => run.run_id);
  const computing = running.filter(takesRunSlot);
  if (computing.length < (limit ?? 1)) return { activeRunIds, limit, blockedReason: null };
  const value = formatList(computing.map(runDisplayName));
  const blockedReason =
    limit === null
      ? t("目前「{value}」還在執行；還沒讀到主控同時能執行幾個 run，先當作 1 個", { value })
      : t("主控同時最多執行 {count} 個 run；目前「{value}」還在執行", { count: limit, value });
  return { activeRunIds, limit, blockedReason };
}

export function useRunSlots(): RunSlots {
  const { runs: running } = useActiveRuns();
  const limit = useController().data?.max_active_runs ?? null;
  return useMemo(() => runSlots(running, limit), [running, limit]);
}
