// run 甘特圖（純函式）：只用步驟的 started_at／finished_at（Controller runner 以同一個主控時鐘記錄）。
// 0＝run.created_at；泳道＝Node · resource_group（runner 依 (node_id, resource_group) 序列化步驟）。
// 沒有 started_at 的步驟不畫（絕不在 0 畫零長度條），另列「未開始／未量測」；進行中的步驟延伸到呼叫端給的 now。
import { runSteps, type RunStepView, type StepState, type WireRun } from "@/api/types";
import { statusSpec } from "@/components/common/statusSpec";
import { providerKind } from "@/components/workbench/kinds";
import type { Tone } from "@/components/workbench/tones";
import { groupTag } from "@/lib/deviceTag";
import { shortId } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { isoToMs } from "@/lib/time";
import type { DescriptorLookup, NodeLabelLookup } from "@/features/pipelines";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface RunGanttProps {
  run: WireRun;
  lookup: DescriptorLookup;
  selectedStepId: string | null;
  onSelectStep: (id: string | null) => void;
  /** 現在時間（ms epoch）；run 進行中時由呼叫端定期更新並重繪，元件本身不開計時器。 */
  now: number;
  /** 選填：Node 顯示名稱（例如 `(id) => nodeLabel(catalog.data, id)`）；未提供時用縮短的 node_id。 */
  nodeLabel?: NodeLabelLookup;
  className?: string;
}

export type GanttStepState = StepState | "unknown";

export interface GanttBar {
  stepId: string;
  state: GanttStepState;
  laneKey: string;
  /** 泳道內的列（重疊時往下排）。 */
  row: number;
  /** 相對 0 點的毫秒。 */
  startMs: number;
  endMs: number;
  durationMs: number;
  /** 進行中：結束端是 now（瀏覽器時間），不是實測結束時間。 */
  running: boolean;
  /** 進行中且 now 未知：長度不可得（不顯示「至今」時間）。 */
  elapsedUnknown: boolean;
  tone: Tone;
  providerId: string | null;
  kindLabel: string;
  componentId: string | null;
  nodeId: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  remoteOutcomeUnknown: boolean;
}

export interface GanttLane {
  key: string;
  /** 「Node A（GPU 0 + GPU 1） · gpu-0」。 */
  label: string;
  nodeLabel: string;
  resourceGroup: string | null;
  /** resource_group 來源：run 步驟的 effective 設定（當時實際）、目前目錄、或未知。 */
  groupSource: "run" | "catalog" | null;
  rows: number;
  bars: GanttBar[];
}

export interface GanttUnmeasured {
  stepId: string;
  state: GanttStepState;
  reason: string;
  componentId: string | null;
  nodeId: string | null;
}

export interface GanttTick {
  ms: number;
  label: string;
}

export interface GanttModel {
  /** 0 點（ISO）；created_at 無法解析時退回最早的 started_at。 */
  originIso: string | null;
  originSource: "created_at" | "first_start" | null;
  /** 有資料的最晚時間（步驟結束、run 結束或 now）。 */
  spanMs: number;
  /** 軸的結尾（span 進位到刻度）。 */
  axisEndMs: number;
  tickStepMs: number;
  ticks: GanttTick[];
  lanes: GanttLane[];
  unmeasured: GanttUnmeasured[];
  /** 依開始時間排序的所有條（鍵盤移動順序）。 */
  bars: GanttBar[];
  runRunning: boolean;
  /** run 進行中時 now 的位置；否則 null。 */
  nowMs: number | null;
  /** run.finished_at 的位置；未結束或無法解析＝null。 */
  runEndMs: number | null;
}

/** 刻度間距候選：0.1／0.2／0.5 s、1／2／5／10／30 s、1／2／5／10／30 min、1 h。 */
export const TICK_STEPS_MS = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000] as const;

export function tickStep(spanMs: number, maxTicks = 8): number {
  const span = Math.max(0, spanMs);
  const limit = Math.max(1, maxTicks);
  return TICK_STEPS_MS.find((step) => span / step <= limit) ?? Math.ceil(span / limit / 3_600_000) * 3_600_000;
}

/** 刻度文字：「0 s」「1.5 s」「30 s」「1 min」「1 min 30 s」。 */
export function formatTick(ms: number, stepMs: number): string {
  if (ms === 0) return "0 s";
  if (ms < 60_000) return stepMs < 1_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** 相對 0 點的位移文字（aria／提示用）：「+14.5 s」「+1 min 05.2 s」。 */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? "−" : "+";
  const abs = Math.abs(ms);
  if (abs < 59_950) return `${sign}${(abs / 1000).toFixed(abs < 9_995 ? 2 : 1)} s`;
  const tenths = Math.round(abs / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${sign}${minutes} min ${seconds} s`;
}

/** 步驟當時實際的 resource_group：settings.effective.load.device.resource_group。 */
function effectiveGroup(view: RunStepView): string | null {
  const load = view.settings && isRecord(view.settings.effective) ? view.settings.effective.load : null;
  const device = isRecord(load) ? load.device : null;
  const group = isRecord(device) ? device.resource_group : null;
  return typeof group === "string" && group.length > 0 ? group : null;
}

const NOT_STARTED_REASON: Partial<Record<GanttStepState, string>> = {
  pending: t("尚未開始"),
  waiting: t("等待同一 Node／資源群組的步驟完成"),
  skipped: t("未執行（上游失敗或 run 停止），沒有開始時間"),
  cancelled: t("取消時尚未開始"),
  interrupted: t("中斷時尚未開始"),
};

function stateText(state: GanttStepState): string {
  return state === "unknown" ? t("狀態未知") : statusSpec("step", state).label;
}

export interface GanttOptions {
  nodeLabel?: NodeLabelLookup;
  maxTicks?: number;
}

export function buildGanttModel(run: WireRun, lookup: DescriptorLookup, now: number, options: GanttOptions = {}): GanttModel {
  const views = runSteps(run);
  const definitions = new Map(run.request.pipeline.steps.map((step) => [step.step_id, step]));
  const created = isoToMs(run.created_at);
  const starts = views.map((view) => isoToMs(view.started_at)).filter((value): value is number => value !== null);
  const origin = created ?? (starts.length > 0 ? Math.min(...starts) : null);
  const originSource = created !== null ? "created_at" : origin !== null ? "first_start" : null;
  const runRunning = run.state === "running";
  // now 早於 0 點（例如呼叫端第一個 frame 還沒有時間，傳 0）＝現在未知：進行中的條只標起點，不畫「現在」線。
  const nowKnown = runRunning && origin !== null && Number.isFinite(now) && now >= origin;

  const lanes = new Map<string, GanttLane>();
  const unmeasured: GanttUnmeasured[] = [];
  const bars: GanttBar[] = [];
  for (const view of views) {
    const definition = definitions.get(view.step_id);
    const nodeId = view.node_id ?? (definition?.node_id || null);
    const componentId = view.component_id ?? (definition?.component_id || null);
    const descriptor = nodeId && componentId ? lookup(nodeId, componentId) : null;
    const state: GanttStepState = Object.hasOwn(run.steps, view.step_id) ? view.state : "unknown";
    const start = isoToMs(view.started_at);
    const end = isoToMs(view.finished_at);
    const skip = (reason: string) => unmeasured.push({ stepId: view.step_id, state, reason, componentId, nodeId });

    if (origin === null || start === null) {
      skip(view.started_at ? t("開始時間無法解析") : (NOT_STARTED_REASON[state] ?? t("沒有 started_at（未量測）")));
      continue;
    }
    let endMs: number;
    let running = false;
    if (end !== null) {
      if (end < start) {
        skip(t("結束早於開始（時戳異常）"));
        continue;
      }
      endMs = end - origin;
    } else if (state === "running" && runRunning) {
      running = true;
      endMs = (nowKnown ? Math.max(start, now) : start) - origin;
    } else {
      skip(view.finished_at ? t("結束時間無法解析") : t("{state}：有開始時間但沒有結束時間", { state: stateText(state) }));
      continue;
    }

    const runGroup = effectiveGroup(view);
    const catalogGroup = descriptor?.device.resource_group || null;
    const resourceGroup = runGroup ?? catalogGroup;
    const nodeLabel = nodeId ? (options.nodeLabel?.(nodeId) ?? shortId(nodeId)) : t("Node 未知");
    const laneKey = `${nodeId ?? ""}␟${resourceGroup ?? ""}`;
    let lane = lanes.get(laneKey);
    if (!lane) {
      lane = {
        key: laneKey,
        label: resourceGroup ? `[${groupTag(resourceGroup) ?? resourceGroup}] ${nodeLabel}` : t("{nodeLabel} · 資源群組未知", { nodeLabel }),
        nodeLabel,
        resourceGroup,
        groupSource: runGroup ? "run" : catalogGroup ? "catalog" : null,
        rows: 1,
        bars: [],
      };
      lanes.set(laneKey, lane);
    }
    const kind = providerKind(descriptor?.provider_id);
    const startMs = start - origin;
    const bar: GanttBar = {
      stepId: view.step_id,
      state,
      laneKey,
      row: 0,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      running,
      elapsedUnknown: running && !nowKnown,
      tone: descriptor ? kind.tone : "neutral",
      providerId: descriptor?.provider_id ?? null,
      kindLabel: descriptor ? kind.label : t("元件不在目錄"),
      componentId,
      nodeId,
      startedAt: view.started_at ?? "",
      finishedAt: view.finished_at,
      errorCode: view.error?.code ?? null,
      errorMessage: view.error?.message || null,
      remoteOutcomeUnknown: view.remote_outcome_unknown || view.error?.remote_outcome_unknown === true,
    };
    lane.bars.push(bar);
    bars.push(bar);
  }

  // 泳道內：依開始時間排序，重疊的條往下一列（同一資源群組由 runner 序列化，通常只有一列）。
  for (const lane of lanes.values()) {
    lane.bars.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const rowEnds: number[] = [];
    for (const bar of lane.bars) {
      let row = rowEnds.findIndex((rowEnd) => rowEnd <= bar.startMs);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(bar.endMs);
      } else rowEnds[row] = bar.endMs;
      bar.row = row;
    }
    lane.rows = Math.max(1, rowEnds.length);
  }
  const orderedLanes = [...lanes.values()].sort((a, b) => (a.bars[0]?.startMs ?? 0) - (b.bars[0]?.startMs ?? 0) || a.label.localeCompare(b.label));
  bars.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.stepId.localeCompare(b.stepId));

  const finished = isoToMs(run.finished_at);
  const runEndMs = origin !== null && finished !== null && !runRunning ? finished - origin : null;
  const nowMs = nowKnown && origin !== null ? now - origin : null;
  const spanMs = Math.max(0, ...bars.map((bar) => bar.endMs), runEndMs ?? 0, nowMs ?? 0);
  const step = tickStep(spanMs, options.maxTicks);
  const axisEndMs = Math.max(step, Math.ceil(spanMs / step) * step);
  const ticks: GanttTick[] = [];
  for (let ms = 0; ms <= axisEndMs + 1e-6; ms += step) ticks.push({ ms, label: formatTick(ms, step) });

  return {
    originIso: originSource === "created_at" ? run.created_at : originSource === "first_start" ? (views.find((view) => isoToMs(view.started_at) === origin)?.started_at ?? null) : null,
    originSource,
    spanMs,
    axisEndMs,
    tickStepMs: step,
    ticks,
    lanes: orderedLanes,
    unmeasured,
    bars,
    runRunning,
    nowMs,
    runEndMs,
  };
}

/** 條的完整說明（aria-label 與提示共用）。 */
/** 條的完整說明；withStep=false 時不含開頭的「步驟 X」（旁邊已經顯示 step_id 時用，不靠字串取代去掉它）。 */
export function describeBar(bar: GanttBar, lane: GanttLane | undefined, options: { withStep?: boolean } = {}): string {
  const parts = options.withStep === false ? [stateText(bar.state)] : [t("步驟 {stepId}", { stepId: bar.stepId }), stateText(bar.state)];
  if (lane) parts.push(lane.label);
  parts.push(t("開始 {startMs}", { startMs: formatOffset(bar.startMs) }));
  if (bar.elapsedUnknown) parts.push(t("進行中（目前時間未知）"));
  else parts.push(bar.running ? t("進行中，至今 {durationMs}（依瀏覽器時間）", { durationMs: formatDurationShort(bar.durationMs) }) : t("耗時 {durationMs}", { durationMs: formatDurationShort(bar.durationMs) }));
  if (bar.errorCode) parts.push(t("錯誤 {errorCode}", { errorCode: bar.errorCode }));
  if (bar.remoteOutcomeUnknown) parts.push(t("遠端結果未知"));
  return formatList(parts, { separator: "，" });
}

/** 條上的時間文字（比 formatMs 精簡，放得進條內）。 */
export function formatDurationShort(ms: number): string {
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(ms < 9_995 ? 2 : 1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}
