// Recorder metrics of the selected run (the detail's 「指標」 tab): one card per call recording, in a grid, titled with
// the step's name from the one step table (the component id is secondary monospace text). The last calls report as
// the run ends, so the recordings are read once more when it ends and then every 2 s while a call still lacks its
// recording or summary (for at most 30 s after the end; a summary that never comes then shows as not received).
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import type { Metric, Recording } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import type { WireRun } from "@/api/types";
import { EmptyState } from "@/components/common/EmptyState";
import { CARD } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { runRecordingsOptions } from "../../hooks/useRunProgress";
import { splitRunStepId } from "../../model/pipelines";
import { callRecordingsIncomplete, isSummaryPending, STEP_ROLE_BY_PROVIDER, STEP_ROLE_LABELS, stepIdForRecording, stepLabel, type ProviderLookup } from "../../model/progress";
import { branchLabel, type QueueItem, recordingState, takeForSuffix } from "../../model/renderQueue";
import { TakeStateMark } from "../marks";
import { formatSpan, formatSpanExact } from "./time";
import { t, tServer } from "@/i18n";

/** How long after a run ends its recordings are still read while some call has not fully reported, and how often. */
const SETTLE_MS = 30_000;
const SETTLE_POLL_MS = 2000;

/** The run has ended at most SETTLE_MS ago and some call of it has not fully reported. */
function settling(run: WireRun | undefined, items: Parameters<typeof callRecordingsIncomplete>[1]): boolean {
  if (!run || run.state === "running" || !run.finished_at) return false;
  const since = Date.now() - Date.parse(run.finished_at);
  return Number.isFinite(since) && since < SETTLE_MS && callRecordingsIncomplete(run, items);
}

const METRICS: { name: string; label: string; kind: "ms" | "bytes" }[] = [
  { name: "host_wall_ms", label: t("總耗時"), kind: "ms" },
  { name: "steps.gpu_event_ms_p50", label: t("每步 GPU（p50）"), kind: "ms" },
  { name: "torch_allocated_peak_bytes", label: t("顯存 allocated 峰值"), kind: "bytes" },
  { name: "torch_reserved_peak_bytes", label: t("顯存 reserved 峰值"), kind: "bytes" },
  { name: "weight_h2d_completed_bytes", label: t("權重 H2D（完成）"), kind: "bytes" },
  { name: "prefetch_wait_ms", label: t("等待權重預取"), kind: "ms" },
  { name: "network_received_bytes", label: t("網路接收"), kind: "bytes" },
];

function MetricLine({ metric, label, kind }: { metric: Metric | undefined; label: string; kind: "ms" | "bytes" }) {
  if (!metric) return null;
  const value = metric.value;
  const measured = typeof value === "number";
  const text = measured ? (kind === "ms" ? formatSpan(value) : formatBytes(value)) : t("未量測");
  const why = tServer(metric.reason) ?? metric.method ?? null;
  const title = [measured && kind === "ms" ? formatSpanExact(value) : null, why].filter(Boolean).join("\n");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-caption" title={title || undefined}>
      <dt className="truncate text-fg-tertiary">{label}</dt>
      <dd className={cn("machine text-right", measured ? "text-fg" : "text-fg-tertiary")}>{text}</dd>
    </div>
  );
}

/** The card's title: the step's name and, in a run with several branches, which one; null when the step is unknown. */
function recordingTitle(recording: Recording, run: WireRun | undefined, item: QueueItem, lookup: ProviderLookup): { stage: string; branch: string | null } {
  const stepId = stepIdForRecording(run, recording.context);
  if (run && stepId) {
    const { suffix } = splitRunStepId(run, stepId);
    return { stage: stepLabel(run, stepId, lookup), branch: item.takes.length > 1 ? branchLabel(item, takeForSuffix(item, suffix), "") : null };
  }
  // Not matched to a step (yet): the provider still names the role
  const role = STEP_ROLE_BY_PROVIDER[recording.context.provider_id];
  return { stage: role ? STEP_ROLE_LABELS[role] : recording.context.component_id, branch: null };
}

export function RunMetrics({ item, run, lookup }: { item: QueueItem; run: WireRun | undefined; lookup: ProviderLookup }) {
  const running = item.state === "rendering";
  const options = runRecordingsOptions(item.runId, running);
  const recordings = useQuery({
    ...options,
    // While running: the shared interval (runRecordingsOptions); then the settling one
    refetchInterval: (query) => (typeof options.refetchInterval === "number" ? options.refetchInterval : settling(run, query.state.data?.items ?? []) ? SETTLE_POLL_MS : false),
  });
  const { refetch } = recordings;
  // The run has just ended: read at once (the interval above then goes on while a call has not fully reported)
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void refetch();
    wasRunning.current = running;
  }, [running, refetch]);
  const items = [...(recordings.data?.items ?? [])].sort((a, b) => a.context.created_at.localeCompare(b.context.created_at));
  if (recordings.isError && items.length === 0) {
    return <p className="text-data text-danger">{t("讀取紀錄失敗：{value}", { value: isApiError(recordings.error) ? tServer(recordings.error.message) : "" })}</p>;
  }
  if (items.length === 0) {
    if (recordings.isPending) return <p className="text-data text-fg-tertiary">{t("讀取紀錄…")}</p>;
    return <EmptyState size="compact" title={running ? t("元件完成後會上報量測（每秒批次）。") : t("這個 run 沒有可顯示的呼叫紀錄。")} />;
  }
  return (
    <ul aria-label={t("實測指標")} className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {items.map((recording, index) => {
        const title = recordingTitle(recording, run, item, lookup);
        const pending = isSummaryPending(recording.summary);
        return (
          <li key={recording.context.recording_id} ref={reveal(index)} className={cn(CARD, "grid min-w-0 content-start gap-1.5 p-2.5")}>
            <header className="flex min-w-0 items-start gap-2">
              <span className="grid min-w-0">
                <span className="truncate text-data font-medium text-fg">{title.stage}</span>
                {title.branch ? <span className="truncate text-caption text-fg-secondary">{title.branch}</span> : null}
                <code className="machine truncate text-[11px] text-fg-tertiary" title={recording.context.component_id}>
                  {recording.context.component_id}
                </code>
              </span>
              <TakeStateMark state={recordingState(recording.summary, running)} className="ml-auto" />
            </header>
            {pending ? (
              <p className="text-caption text-fg-tertiary">{running ? t("summary 尚未收到；呼叫結束後才有完整指標。") : t("summary 尚未收到（可能上報缺段或程序中斷）。")}</p>
            ) : (
              <dl className="grid gap-0.5">
                {METRICS.map((metric) => (
                  <MetricLine key={metric.name} metric={recording.summary.metrics[metric.name]} label={metric.label} kind={metric.kind} />
                ))}
              </dl>
            )}
            <Link to={`/records/recordings/${encodeURIComponent(recording.context.recording_id)}`} className="inline-flex min-h-8 items-center gap-1 justify-self-start text-caption">
              <ExternalLink aria-hidden className="size-3" />
              {t("完整紀錄")}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
