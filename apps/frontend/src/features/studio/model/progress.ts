// DiT 去噪進度的純邏輯：run 步驟 → DiT 分支、總步數、對應的 recording；runtime stream 事件 → 逐步紀錄 → 進度摘要。
//
// 進度只有兩種來源，畫面上標明且不混為一談：
// - step（實測）：recorder 的 step 事件（host_ms／gpu_event_ms）。H3 runtime 在去噪迴圈結束、CUDA event 解算後才一次上報。
// - transfer（推導）：去噪中即時上報的權重搬運事件帶 step_index（block offload 才有）。某一步第一次搬運出現＝該步已開始；
//   相鄰兩步第一次搬運的 monotonic 間隔≈前一步耗時（同一 clock domain 才相減）。
// 沒有逐步訊號就不顯示進度；DiT 這個階段的剩餘（stageRemainingMs）只用已量測（或推導）的步驟耗時、至少 1 步才算。
// 它只涵蓋 DiT 去噪，不是整個 run 的剩餘（那個由成本紀錄收斂，見 eta/runRemaining.ts）。
import { indexCatalog } from "@/api/catalog";
import type { Catalog, Recording, RecordingSummary, RunStepComponentLoad } from "@/api/generated/contracts";
import { parseRunStep, runSteps, type RunStepView, type WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";
import { runBranchSuffixes, runStepIds, splitRunStepId } from "./pipelines";
import { declaresGenerator } from "./providerTraits";
import { t, tServer } from "@/i18n";

const DECIMAL = /^\d{1,30}$/;

// ---------------------------------------------------------------- 步驟角色（依元件的 provider）

/**
 * run 步驟在 Studio 畫面上的角色。步驟 id 來自使用者的元件組合，所以角色依 provider 判斷，不依 id：H3 的 provider 有固定角色；
 * 其他模型家族的生成元件（facts 宣告 studio_generation／studio_creative／studio_edit，例如 Wan）是它的去噪步驟（dit）。
 */
export type StepRole = "te" | "dit" | "video" | "audio" | "mux" | "ref" | "refVideo" | "refAudio" | "frame" | "concat";

export const STEP_ROLE_BY_PROVIDER: Readonly<Record<string, StepRole>> = {
  "h3.conditioning": "te",
  "h3.dit": "dit",
  "h3.video_decode": "video",
  "h3.audio_decode": "audio",
  "media.mux": "mux",
  "h3.reference": "ref",
  "h3.video_encode": "refVideo",
  "h3.audio_encode": "refAudio",
  "media.frame": "frame",
  "media.concat": "concat",
};

export const STEP_ROLE_LABELS: Record<StepRole, string> = {
  te: t("文字條件"),
  dit: t("DiT 去噪"),
  video: t("影片解碼"),
  audio: t("音訊解碼"),
  mux: t("封裝"),
  ref: t("參考編碼"),
  refVideo: t("參考畫面編碼"),
  refAudio: t("參考音訊編碼"),
  frame: t("取出首影格"),
  concat: t("序列接合"),
};

function isRole(value: string): value is StepRole {
  return Object.hasOwn(STEP_ROLE_LABELS, value);
}
/** Step ids the reference templates use, for a run whose component is no longer in the catalog. */
const ROLE_BY_STEP_ID: Readonly<Record<string, StepRole>> = { conditioning: "te", denoise: "dit", ref_visual: "refVideo", ref_audio: "refAudio" };

/**
 * 步驟元件（node_id＋component_id）→ provider_id；查不到（元件已刪除、目錄未載入）回 null。目錄來的查詢另外附 generator：
 * 元件是否宣告自己是 Studio 的生成元件（providerTraits.declaresGenerator）。
 */
export type ProviderLookup = ((nodeId: string, componentId: string) => string | null) & { generator?: (nodeId: string, componentId: string) => boolean };

export function catalogLookup(catalog: Catalog | undefined): ProviderLookup {
  const index = indexCatalog(catalog);
  const lookup: ProviderLookup = (nodeId, componentId) => index.component(nodeId, componentId)?.provider_id ?? null;
  lookup.generator = (nodeId, componentId) => declaresGenerator(index.component(nodeId, componentId)?.facts);
  return lookup;
}

/**
 * 步驟角色：provider 查得到就依 provider（不認得的 provider＝null）；查不到時（例如元件已從目錄移除），範本 id 剛好是
 * 角色名（te／dit／video…）才採用。
 */
export function stepRole(run: WireRun, stepId: string, lookup?: ProviderLookup, suffixes: readonly string[] = runBranchSuffixes(run)): StepRole | null {
  const def = run.request.pipeline.steps.find((step) => step.step_id === stepId);
  const view = parseRunStep(stepId, run.steps[stepId]);
  const nodeId = view.node_id ?? def?.node_id ?? null;
  const componentId = view.component_id ?? def?.component_id ?? null;
  const provider = lookup && (nodeId != null && nodeId !== "") && (componentId != null && componentId !== "") ? lookup(nodeId, componentId) : null;
  if (provider != null && provider !== "") return STEP_ROLE_BY_PROVIDER[provider] ?? (lookup?.generator?.(nodeId ?? "", componentId ?? "") === true ? "dit" : null);
  const { base } = splitRunStepId(run, stepId, suffixes);
  return isRole(base) ? base : (ROLE_BY_STEP_ID[base] ?? null);
}

/** 畫面上的步驟名稱：認得的角色用中文，其餘用元件組合裡的步驟 id。 */
export function stepLabel(run: WireRun, stepId: string, lookup?: ProviderLookup, suffixes: readonly string[] = runBranchSuffixes(run)): string {
  const role = stepRole(run, stepId, lookup, suffixes);
  return role ? STEP_ROLE_LABELS[role] : splitRunStepId(run, stepId, suffixes).base;
}

const branchIndex = (suffix: string) => (suffix ? Number(suffix.slice(1)) : 0);

export type StepStateView = RunStepView["state"];

// ---------------------------------------------------------------- 逐步紀錄（由事件累積）

export interface StepSample {
  hostMs: number;
  gpuMs: number | null;
}

export interface StepLog {
  /** 已讀到的最大 seq：下一次查詢的 after_seq。 */
  lastSeq: number;
  /** recorder step 事件（實測），以 step_index 為 key；重複事件以最後一筆為準。 */
  steps: ReadonlyMap<number, StepSample>;
  /** 每個 step_index 最早一筆權重搬運的 monotonic_ns。 */
  transferStarts: ReadonlyMap<number, bigint>;
  /** 搬運事件的 clock_domain；出現第二個 domain 時 mixedClock=true，不再推導間隔。 */
  clockDomain: string | null;
  mixedClock: boolean;
  /** 讀到缺段（上報是 best-effort，可能丟批）。 */
  gap: boolean;
}

export function emptyStepLog(): StepLog {
  return { lastSeq: 0, steps: new Map(), transferStarts: new Map(), clockDomain: null, mixedClock: false, gap: false };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stepIndexOf(data: Record<string, unknown>): number | null {
  const index = data["step_index"];
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * 把一頁事件併入紀錄（不可變）。可重複套用同一批事件、可亂序：step 以 step_index 去重，搬運起點取最小 monotonic_ns。
 * 沒有任何變化時回傳原物件。
 */
export function foldEvents(log: StepLog, events: readonly unknown[], options: { gap?: boolean } = {}): StepLog {
  let lastSeq = log.lastSeq;
  let steps: Map<number, StepSample> | null = null;
  let starts: Map<number, bigint> | null = null;
  let clockDomain = log.clockDomain;
  let mixedClock = log.mixedClock;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (typeof event["seq"] === "number" && Number.isInteger(event["seq"]) && event["seq"] > lastSeq) lastSeq = event["seq"];
    if (!isRecord(event["data"])) continue;
    const index = stepIndexOf(event["data"]);
    if (index === null) continue;
    if (event["kind"] === "step") {
      const hostMs = finite(event["data"]["host_ms"]);
      if (hostMs === null || hostMs < 0) continue;
      const sample: StepSample = { hostMs, gpuMs: finite(event["data"]["gpu_event_ms"]) };
      const previous = (steps ?? log.steps).get(index);
      if (previous?.hostMs === sample.hostMs && previous.gpuMs === sample.gpuMs) continue;
      steps ??= new Map(log.steps);
      steps.set(index, sample);
    } else if (event["kind"] === "transfer") {
      if (typeof event["monotonic_ns"] !== "string" || !DECIMAL.test(event["monotonic_ns"])) continue;
      const domain = typeof event["data"]["clock_domain"] === "string" ? event["data"]["clock_domain"] : null;
      if (domain !== null) {
        if (clockDomain === null) clockDomain = domain;
        else if (domain !== clockDomain) mixedClock = true;
      }
      const ns = BigInt(event["monotonic_ns"]);
      const previous = (starts ?? log.transferStarts).get(index);
      if (previous !== undefined && previous <= ns) continue;
      starts ??= new Map(log.transferStarts);
      starts.set(index, ns);
    }
  }
  const gap = log.gap || options.gap === true;
  if (lastSeq === log.lastSeq && !steps && !starts && clockDomain === log.clockDomain && mixedClock === log.mixedClock && gap === log.gap) return log;
  return { lastSeq, steps: steps ?? log.steps, transferStarts: starts ?? log.transferStarts, clockDomain, mixedClock, gap };
}

// ---------------------------------------------------------------- 總步數與分支

export type TotalSource = "effective" | "requested";

export interface TotalSteps {
  value: number | null;
  /** effective＝元件回報這次呼叫實際生效的參數；requested＝run 建立時凍結、實際送出的 invoke 參數。 */
  source: TotalSource | null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function effectiveSteps(settings: unknown): number | null {
  if (!isRecord(settings) || !isRecord(settings["effective"]) || !isRecord(settings["effective"]["parameters"])) return null;
  return positiveInt(settings["effective"]["parameters"]["steps"]);
}

/**
 * 去噪總步數。依序：recording context 的 effective 參數（呼叫一開始就上報）→ run 步驟結束後的 effective 參數 →
 * run 建立時凍結的 `invoke_snapshot`（元件預設 invoke ⊕ 這一步的 parameters，就是送給元件的值）。都沒有就是未知，不猜預設值。
 */
export function resolveTotalSteps(rawStep: unknown, context?: { settings?: unknown } | null): TotalSteps {
  const fromContext = effectiveSteps(context?.settings);
  if (fromContext !== null) return { value: fromContext, source: "effective" };
  const record = isRecord(rawStep) ? rawStep : {};
  const fromStep = effectiveSteps(record["settings"]);
  if (fromStep !== null) return { value: fromStep, source: "effective" };
  const requested = isRecord(record["invoke_snapshot"]) ? positiveInt(record["invoke_snapshot"]["steps"]) : null;
  if (requested !== null) return { value: requested, source: "requested" };
  return { value: null, source: null };
}

export interface DitBranch {
  stepId: string;
  /** "" 或 "_0"、"_1"…（與 take.output_key 的後綴相同）。 */
  suffix: string;
  index: number;
  step: RunStepView;
  raw: unknown;
}

/** run 中每個 DiT 步驟（依 provider；批次／變體每個分支一個），依分支順序。 */
export function ditBranches(run: WireRun | undefined, lookup?: ProviderLookup): DitBranch[] {
  if (!run) return [];
  const suffixes = runBranchSuffixes(run);
  return runStepIds(run)
    .flatMap((stepId) => {
      if (stepRole(run, stepId, lookup, suffixes) !== "dit") return [];
      const { suffix } = splitRunStepId(run, stepId, suffixes);
      const raw = run.steps[stepId];
      return [{ stepId, suffix, index: branchIndex(suffix), step: parseRunStep(stepId, raw), raw }];
    })
    .sort((a, b) => a.index - b.index);
}

/** 步驟的 recording：結束後 run 會帶 recording_id；執行中只能以 call_id 對到 recording context（context 沒有 step_id）。 */
export function findBranchRecording(step: Pick<RunStepView, "call_id" | "recording_id">, recordings: readonly Recording[]): Recording | null {
  if (step.recording_id != null && step.recording_id !== "") {
    const byId = recordings.find((item) => item.context.recording_id === step.recording_id);
    if (byId) return byId;
  }
  if (!(step.call_id != null && step.call_id !== "")) return null;
  return recordings.find((item) => item.context.call_id === step.call_id && item.context.operation === "invoke") ?? null;
}

// ---------------------------------------------------------------- 進度摘要

export type ProgressSource = "step" | "transfer" | "none";

export interface StepDuration {
  index: number;
  ms: number;
}

export interface DitProgress {
  total: number | null;
  totalSource: TotalSource | null;
  /** 已完成步數（有證據的下限）；沒有任何逐步訊號＝null。 */
  completed: number | null;
  /** 進行中的步（從 1 起算）；不知道或迴圈已結束＝null。 */
  current: number | null;
  /** 已完成步數達到總步數（元件可能仍在收尾）。 */
  loopDone: boolean;
  source: ProgressSource;
  /** 每步耗時（step 來源＝實測 host_ms；transfer 來源＝推導間隔），依 step_index 排序。 */
  durations: StepDuration[];
  typicalMs: number | null;
  lastMs: number | null;
  /** 實測 gpu_event_ms 的中位數（只有 step 來源）。 */
  gpuTypicalMs: number | null;
  /** DiT 去噪這個階段的剩餘：剩餘步數 × 本次每步中位數（不含其他階段，不是整個 run 的剩餘）；未達條件＝null。 */
  stageRemainingMs: number | null;
  fraction: number | null;
  gap: boolean;
}

/** 排序中位數（偶數個取中間兩個的平均）；空陣列 null。 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

function transferDurations(log: StepLog): StepDuration[] {
  if (log.mixedClock) return [];
  const out: StepDuration[] = [];
  for (const [index, start] of [...log.transferStarts.entries()].sort((a, b) => a[0] - b[0])) {
    const next = log.transferStarts.get(index + 1);
    if (next !== undefined && next > start) out.push({ index, ms: Number(next - start) / 1_000_000 });
  }
  return out;
}

export function summarizeDit(log: StepLog | null, total: TotalSteps, state: StepStateView): DitProgress {
  const stepEntries = log ? [...log.steps.entries()].sort((a, b) => a[0] - b[0]) : [];
  const startIndexes = log ? [...log.transferStarts.keys()].sort((a, b) => a - b) : [];
  const stepMax = stepEntries.at(-1)?.[0] ?? null;
  const startMax = startIndexes.at(-1) ?? null;
  const source: ProgressSource = stepEntries.length > 0 ? "step" : startIndexes.length > 0 ? "transfer" : "none";
  // 兩種證據都是「至少完成幾步」的下限：第 k 步有 step 事件＝k+1 步完成；第 k 步已開始搬運＝前 k 步完成。
  let completed: number | null = null;
  if (stepMax !== null) completed = stepMax + 1;
  if (startMax !== null) completed = Math.max(completed ?? 0, startMax);
  const started = Math.max(stepMax ?? -1, startMax ?? -1);
  const durations = source === "step" ? stepEntries.map(([index, sample]) => ({ index, ms: sample.hostMs })) : log && source === "transfer" ? transferDurations(log) : [];
  const gpuValues = stepEntries.flatMap(([, sample]) => (sample.gpuMs === null ? [] : [sample.gpuMs]));
  const totalValue = total.value;
  const running = state === "running";
  let current: number | null = null;
  if (running && completed !== null) {
    if (started + 1 > completed) current = started + 1;
    else if (totalValue !== null && completed < totalValue) current = completed + 1;
  }
  if (state === "succeeded" && totalValue !== null) {
    completed = Math.max(completed ?? 0, totalValue);
    current = null;
  }
  const loopDone = totalValue !== null && completed !== null && completed >= totalValue;
  if (loopDone) current = null;
  const typicalMs = median(durations.map((item) => item.ms));
  const stageRemainingMs = running && totalValue !== null && completed !== null && typicalMs !== null ? Math.max(0, totalValue - completed) * typicalMs : null;
  const fraction = totalValue !== null && completed !== null ? Math.min(1, Math.max(0, completed / totalValue)) : state === "succeeded" ? 1 : null;
  return {
    total: totalValue,
    totalSource: total.source,
    completed,
    current,
    loopDone,
    source,
    durations,
    typicalMs,
    lastMs: durations.at(-1)?.ms ?? null,
    gpuTypicalMs: median(gpuValues),
    stageRemainingMs,
    fraction,
    gap: log?.gap ?? false,
  };
}

// ---------------------------------------------------------------- 分支檢視

/** queued＝還沒開始；awaiting_record＝執行中但 recording 還沒上報到主控；live＝執行中且找到 recording；finished＝結束。 */
export type BranchPhase = "queued" | "awaiting_record" | "live" | "finished";

export interface BranchView {
  stepId: string;
  suffix: string;
  index: number;
  state: StepStateView;
  nodeId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  recordingId: string | null;
  phase: BranchPhase;
  progress: DitProgress;
}

function phaseOf(state: StepStateView, recordingId: string | null): BranchPhase {
  if (state === "running") return (recordingId != null && recordingId !== "") ? "live" : "awaiting_record";
  if (state === "pending" || state === "waiting" || state === "unknown") return "queued";
  return "finished";
}

export function buildBranchViews(run: WireRun | undefined, recordings: readonly Recording[], logs: ReadonlyMap<string, StepLog>, lookup?: ProviderLookup): BranchView[] {
  return ditBranches(run, lookup).map((branch) => {
    const recording = findBranchRecording(branch.step, recordings);
    const recordingId = branch.step.recording_id ?? recording?.context.recording_id ?? null;
    const total = resolveTotalSteps(branch.raw, recording?.context ?? null);
    const log = (recordingId != null && recordingId !== "") ? (logs.get(recordingId) ?? null) : null;
    return {
      stepId: branch.stepId,
      suffix: branch.suffix,
      index: branch.index,
      state: branch.step.state,
      nodeId: branch.step.node_id,
      startedAt: branch.step.started_at,
      finishedAt: branch.step.finished_at,
      recordingId,
      phase: phaseOf(branch.step.state, recordingId),
      progress: summarizeDit(log, total, branch.step.state),
    };
  });
}

// ---------------------------------------------------------------- 顯示文字

const END_LABELS: Partial<Record<StepStateView, string>> = { failed: t("失敗"), cancelled: t("已取消"), interrupted: t("已中斷"), skipped: t("略過"), unknown: t("未知") };

export function totalText(progress: Pick<DitProgress, "total">): string {
  return progress.total === null ? "?" : String(progress.total);
}

/** 一行進度描述，例如「第 5／8 步」「等待紀錄上報・共 8 步」「8／8 步・收尾中」。 */
export function progressHeadline(view: Pick<BranchView, "phase" | "state" | "progress">): string {
  const { progress } = view;
  const total = totalText(progress);
  switch (view.phase) {
    case "queued":
      return t("等待中・共 {total} 步", { total });
    case "awaiting_record":
      return t("等待紀錄上報・共 {total} 步", { total });
    case "finished": {
      if (view.state === "succeeded") return t("完成・共 {value} 步", { value: progress.total ?? progress.completed ?? "?" });
      const label = END_LABELS[view.state] ?? view.state;
      return progress.completed !== null ? t("{label}・已完成 {completed}／{total} 步", { label, completed: progress.completed, total }) : label;
    }
    case "live":
      if (progress.current !== null) return t("第 {current}／{total} 步", { current: progress.current, total });
      if (progress.loopDone) return t("{value}／{total} 步・收尾中", { value: progress.completed ?? total, total });
      if (progress.completed !== null) return t("已完成 {completed} 步・共 {total} 步", { completed: progress.completed, total });
      return t("等待逐步事件・共 {total} 步", { total });
  }
}

/** 預估時間用粗粒度（秒），避免看起來像精確量測。 */
export function formatEstimate(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return t("{seconds} 秒", { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? t("{minutes} 分", { minutes }) : t("{minutes} 分 {rest} 秒", { minutes, rest });
}

export const SOURCE_LABELS: Record<ProgressSource, { short: string; detail: string }> = {
  step: { short: t("實測"), detail: t("recorder 的 step 事件（每步 host 時間；有 CUDA event 時另列 GPU 區間）。") },
  transfer: {
    short: t("推導"),
    detail: t("由去噪中即時上報的權重搬運事件（step_index）推導：某步第一次搬運＝該步開始，相鄰兩步的間隔≈前一步耗時。實測的逐步時間在去噪結束後才一次上報。"),
  },
  none: {
    short: t("無逐步訊號"),
    detail: t("還沒有帶 step_index 的事件：去噪迴圈可能尚未開始（載入、組裝輸入），或這個元件在去噪中不上報（例如沒有 block offload），逐步時間要等去噪結束才一次上報。在那之前只顯示已執行時間。"),
  },
};

export const TOTAL_SOURCE_LABELS: Record<TotalSource | "unknown", string> = {
  effective: t("總步數：元件回報這次呼叫實際生效的參數"),
  requested: t("總步數：run 建立時凍結、實際送給元件的參數"),
  unknown: t("總步數未知：run 與紀錄都沒有 steps 參數，不猜預設值"),
};

// ---------------------------------------------------------------- run 層級（佇列）

export interface StepSegment {
  stepId: string;
  stage: string;
  branch: number;
  state: StepStateView;
}

/** run 的步驟依 pipeline 順序、按分支（後綴）分組；用於佇列的分段進度條。stage＝角色（認不得時用範本步驟 id）。 */
export function pipelineSegments(run: WireRun, lookup?: ProviderLookup): StepSegment[][] {
  const suffixes = runBranchSuffixes(run);
  const groups = new Map<number, StepSegment[]>();
  for (const step of runSteps(run)) {
    const { base, suffix } = splitRunStepId(run, step.step_id, suffixes);
    const branch = branchIndex(suffix);
    const list = groups.get(branch) ?? [];
    list.push({ stepId: step.step_id, stage: stepRole(run, step.step_id, lookup, suffixes) ?? base, branch, state: step.state });
    groups.set(branch, list);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

/**
 * 步驟要用的元件正在「使用時載入」時說的話：「載入模型中（約 40 秒）」，或暫時不能載入時「等待模型：<主控說明>」。
 * 秒數是主控依載入紀錄的估計，沒有紀錄就不寫。
 */
export function componentLoadText(load: RunStepComponentLoad): string {
  if (load.phase === "waiting") return t("等待模型：{reason}", { reason: tServer(load.message) });
  const ms = load.estimated_load_ms;
  return ms !== null && ms > 0 ? t("載入模型中（約 {seconds} 秒）", { seconds: Math.max(1, Math.round(ms / 1000)) }) : t("載入模型中");
}

/**
 * 步驟都還在等：有步驟 waiting（同一張 GPU 正被別的步驟用，例如另一個渲染或修正），而且沒有步驟在執行。
 * 這時說「等待資源」，不說「執行中」。
 */
export function waitingForResource(steps: readonly Pick<RunStepView, "state">[]): boolean {
  return steps.some((step) => step.state === "waiting") && !steps.some((step) => step.state === "running");
}

/** 這些步驟裡第一個正在使用時載入的元件；沒有＝null。 */
export function stepsComponentLoad(steps: readonly RunStepView[]): RunStepComponentLoad | null {
  return steps.find((step) => step.component_load != null)?.component_load ?? null;
}

export interface RunActivity {
  done: number;
  total: number;
  /** 目前在做什麼（例如「變體 2／4・DiT 第 5／8 步」）；沒有執行中的步驟時為空字串。 */
  text: string;
}

export function runActivity(run: WireRun, views: readonly BranchView[], noun = t("鏡頭"), lookup?: ProviderLookup): RunActivity {
  const steps = runSteps(run);
  const suffixes = runBranchSuffixes(run);
  const done = steps.filter((step) => step.state === "succeeded" || step.state === "skipped").length;
  const branches = pipelineSegments(run, lookup).length;
  const prefix = (index: number) => (branches > 1 ? t("{noun} {index}／{branches}・", { noun, index: index + 1, branches }) : "");
  const dit = views.find((view) => view.state === "running");
  if (dit) return { done, total: steps.length, text: `${prefix(dit.index)}DiT ${progressHeadline(dit)}` };
  const load = steps.find((step) => step.component_load != null);
  if (load?.component_load) {
    const { suffix } = splitRunStepId(run, load.step_id, suffixes);
    return { done, total: steps.length, text: `${prefix(branchIndex(suffix))}${componentLoadText(load.component_load)}` };
  }
  const runningStep = steps.find((step) => step.state === "running");
  if (runningStep) {
    const { suffix } = splitRunStepId(run, runningStep.step_id, suffixes);
    return { done, total: steps.length, text: t("{suffix}{stepLabel}執行中", { suffix: prefix(branchIndex(suffix)), stepLabel: stepLabel(run, runningStep.step_id, lookup, suffixes) }) };
  }
  if (steps.some((step) => step.state === "waiting")) return { done, total: steps.length, text: t("等待資源") };
  return { done, total: steps.length, text: "" };
}

/** recording 屬於 run 的哪一步（以 recording_id 或 call_id 對應）；批次 run 中同一個元件會有多筆紀錄。 */
export function stepIdForRecording(run: WireRun | undefined, context: Pick<Recording["context"], "recording_id" | "call_id">): string | null {
  if (!run) return null;
  for (const stepId of Object.keys(run.steps)) {
    const step = parseRunStep(stepId, run.steps[stepId]);
    if (step.recording_id === context.recording_id || (context.call_id !== null && step.call_id === context.call_id)) return stepId;
  }
  return null;
}

/** 主控在 Node 尚未上報 summary 時放的 placeholder（state unknown）；執行中不能把它當成失敗。 */
export function isSummaryPending(summary: Pick<RecordingSummary, "state" | "notes">): boolean {
  // 主控寫入的固定文字（伺服器原文，不翻譯）
  return summary.state === "unknown" && summary.notes.some((note) => note.startsWith("summary 尚未收到")); // i18n-ignore
}

/**
 * Whether some call of the run has not fully reported yet: a step that sent a call has no recording among `items`, or
 * its recording still waits for the Node's summary. The last calls of a run often report just after the run ends.
 */
export function callRecordingsIncomplete(run: WireRun, items: readonly Recording[]): boolean {
  return runSteps(run).some((step) => {
    if (!(step.call_id != null && step.call_id !== "")) return false;
    const recording = items.find((item) => item.context.recording_id === step.recording_id || item.context.call_id === step.call_id);
    return !recording || isSummaryPending(recording.summary);
  });
}
