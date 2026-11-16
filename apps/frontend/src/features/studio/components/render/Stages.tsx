// The detail's 「階段」 tab: the pipeline stages across all branches (stepper; it wraps onto a second line instead of
// hiding stages behind a horizontal scroll), the stage matrix (table or one card row per branch, by its own width)
// and the DiT's own measurements (step count, per-step times; its estimates only in tooltips).
import { Rows3, Timer } from "lucide-react";
import type { WireRun } from "@/api/types";
import { Stepper } from "@/components/workbench/Stepper";
import { SectionTitle } from "@/features/studio-shell";
import type { BranchView, ProviderLookup } from "../../model/progress";
import { branchLabel, takeForSuffix, type QueueItem } from "../../model/renderQueue";
import { DitProgressPanel } from "./DitProgress";
import { stageStepperSteps } from "./runView";
import { StageMatrix } from "./StageMatrix";
import { t } from "@/i18n";

export function Stages({ run, item, now, views, error, remaining, lookup }: {
  run: WireRun | undefined;
  item: QueueItem;
  now: number | null;
  views: readonly BranchView[];
  error: string | null;
  /** Estimated seconds left per branch (the running render's), for the DiT cards' tooltips. */
  remaining: ReadonlyMap<string, number | null> | undefined;
  lookup: ProviderLookup;
}) {
  const running = run?.state === "running";
  const showDit = views.length > 0 && (running || views.some((view) => view.progress.durations.length > 0));
  return (
    <div className="grid min-w-0 content-start gap-5">
      <div className="min-w-0">
        <SectionTitle icon={Rows3}>{t("階段")}</SectionTitle>
        {run ? <Stepper steps={stageStepperSteps(run, lookup, now)} label={t("pipeline 階段")} className="mb-3 flex-wrap gap-y-2 overflow-visible" /> : null}
        <StageMatrix run={run} item={item} now={now} views={views} lookup={lookup} />
      </div>
      {showDit ? (
        <div className="min-w-0">
          <SectionTitle icon={Timer}>{t("DiT 去噪進度")}</SectionTitle>
          <DitProgressPanel views={views} labelFor={(view) => branchLabel(item, takeForSuffix(item, view.suffix), view.stepId)} now={now} error={error} remaining={remaining} />
        </div>
      ) : null}
    </div>
  );
}
