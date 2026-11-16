// Step timeline of a run (the detail's 「時間軸」 tab): when each step ran, relative to the run's creation. A batch or
// variations run is grouped by branch (a heading per shot, its steps in pipeline order below), so a long run reads as
// a few short blocks instead of one long list; a step that has not started keeps its row with an empty track. Times
// use the workspace's format; the exact value, the Node and the step id are in the row's tooltip. A data area: crisp
// bars, state colours only.
import { parseRunStep, type WireRun } from "@/api/types";
import { joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { isoToMs } from "@/lib/time";
import { runBranchSuffixes, runStepIds, splitRunStepId } from "../../model/pipelines";
import { stepLabel, stepRole, type ProviderLookup } from "../../model/progress";
import { branchLabel, STEP_STATE_LABEL, takeForSuffix, type QueueItem } from "../../model/renderQueue";
import { nodeShortName } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { formatSpan, formatSpanExact } from "./time";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const STAGE_BAR: Record<string, string> = {
  te: "bg-entity/70",
  dit: "bg-action/70",
  video: "bg-clip-video-edge",
  audio: "bg-clip-audio-edge",
  mux: "bg-fg-tertiary/60",
  concat: "bg-file/70",
  frame: "bg-file/50",
  ref: "bg-entity/45",
  refVideo: "bg-entity/45",
  refAudio: "bg-entity/35",
};

interface Bar {
  stepId: string;
  label: string;
  title: string;
  state: string;
  role: string | null;
  /** Offset and length from the run's creation (ms); null = not started. */
  start: number | null;
  length: number | null;
}

interface Group {
  suffix: string;
  label: string;
  bars: Bar[];
}

function groups(run: WireRun, item: QueueItem, end: number, lookup: ProviderLookup, nodeLabel: (nodeId: string | null) => string): Group[] {
  const origin = isoToMs(run.created_at) ?? 0;
  const suffixes = runBranchSuffixes(run);
  const ids = runStepIds(run);
  return suffixes.map((suffix) => ({
    suffix,
    label: branchLabel(item, takeForSuffix(item, suffix), ""),
    bars: ids
      .filter((id) => splitRunStepId(run, id, suffixes).suffix === suffix)
      .map((id): Bar => {
        const step = parseRunStep(id, run.steps[id]);
        const started = isoToMs(step.started_at);
        const finished = isoToMs(step.finished_at) ?? (step.state === "running" ? end : started);
        const start = started === null ? null : started - origin;
        const length = started === null || finished === null ? null : Math.max(0, finished - started);
        const label = stepLabel(run, id, lookup, suffixes);
        const node = step.node_id ? nodeShortName(nodeLabel(step.node_id)) : "";
        const state = step.state === "unknown" ? "pending" : step.state;
        const title = joinInline([t("{stage}：{state}", { stage: label, state: STEP_STATE_LABEL[state] ?? state }), length !== null ? formatSpanExact(length) : "", node, id].filter(Boolean));
        return { stepId: id, label, title, state, role: stepRole(run, id, lookup, suffixes), start, length };
      }),
  }));
}

function BarRow({ bar, span }: { bar: Bar; span: number }) {
  return (
    <div role="listitem" title={bar.title} className="grid h-6 grid-cols-[minmax(0,9rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-caption">
      <span className={cn("truncate", bar.start === null ? "text-fg-tertiary" : "text-fg-secondary")}>{bar.label}</span>
      <span className="relative h-3.5 min-w-0 overflow-hidden rounded-sm bg-canvas">
        {bar.start !== null && bar.length !== null ? (
          <span
            className={cn(
              "absolute inset-y-0 rounded-sm transition-[width] duration-(--duration-base) ease-linear",
              (bar.role ? STAGE_BAR[bar.role] : undefined) ?? "bg-fg-tertiary/60",
              bar.state === "failed" && "bg-danger/70",
            )}
            style={{ left: `${(bar.start / span) * 100}%`, width: `${Math.max(0.4, (bar.length / span) * 100)}%` }}
          />
        ) : null}
      </span>
      <span className="machine text-right whitespace-nowrap text-fg-secondary">{formatSpan(bar.length)}</span>
    </div>
  );
}

export function Gantt({ run, item, now, lookup }: { run: WireRun; item: QueueItem; now: number | null; lookup: ProviderLookup }) {
  const { catalog } = useStudio();
  const origin = isoToMs(run.created_at) ?? 0;
  const end = isoToMs(run.finished_at) ?? now ?? origin;
  const span = Math.max(1, end - origin);
  const nodeLabel = (nodeId: string | null) => catalog?.nodes.find((node) => node.node_id === nodeId)?.label ?? "";
  const list = groups(run, item, end, lookup, nodeLabel);
  if (!list.some((group) => group.bars.some((bar) => bar.start !== null))) return <p className="text-data text-fg-tertiary">{t("還沒有步驟開始。")}</p>;
  const grouped = list.length > 1;
  return (
    <div className="grid gap-3">
      {list.map((group) => (
        <div key={group.suffix} className="grid gap-0.5">
          {grouped ? <h4 className="truncate pb-0.5 text-caption font-medium text-fg">{group.label}</h4> : null}
          <div role="list" aria-label={grouped ? group.label : t("步驟時間軸")} className="grid gap-0.5">
            {group.bars.map((bar) => (
              <BarRow key={bar.stepId} bar={bar} span={span} />
            ))}
          </div>
        </div>
      ))}
      <p className="text-right text-caption text-fg-tertiary" title={formatSpanExact(span)}>
        <T source={"總計 <0>{span}</0>（以 run 建立時間為起點；同色並排表示不同主機同時在跑）"} values={{ span: formatSpan(span) }} slots={[<span className="machine" />]} />
      </p>
    </div>
  );
}
