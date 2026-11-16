// 從 run 讀回 take 的結果與進度（純函式）：這張圖的輸出名稱記在 params_snapshot.outputs；它的步驟＝輸出步驟的上游
// （自己的 DiT／解碼／合成，加上所有圖片共用的前處理與文字條件）。分支成功即算成功（批次中其他圖失敗不影響）；
// 失敗原因是這張圖的步驟中依 pipeline 順序第一個失敗的步驟。中間預覽只在步驟執行中存在。
import { isFileRef, parseRunStep, type RunStepView, type WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";
import type { ApiErrorBody } from "@/api/generated/contracts";
import type { ImageAsset, ImageTakeState, RunStepPreview, StudioImageTake } from "../types";
import { OUTPUT_IMAGE, OUTPUT_WHITE, ROLE_BY_PROVIDER, ROLE_LABELS, type ImageStepRole } from "./constants";
import { takeSnapshot } from "./params";
import { t } from "@/i18n";

export function asImageAsset(value: unknown): ImageAsset | null {
  if (!isRecord(value) || typeof value.asset_id !== "string" || !isFileRef(value.file)) return null;
  const st = isRecord(value.source_take) ? value.source_take : null;
  return {
    asset_id: value.asset_id,
    file: value.file,
    width: typeof value.width === "number" ? value.width : 0,
    height: typeof value.height === "number" ? value.height : 0,
    mode: value.mode === "RGB" ? "RGB" : "RGBA",
    has_alpha: value.has_alpha === true,
    white_matte: value.white_matte === true,
    source_take:
      st && typeof st.project_id === "string" && typeof st.image_shot_id === "string" && typeof st.take_id === "string"
        ? { project_id: st.project_id, image_shot_id: st.image_shot_id, take_id: st.take_id }
        : null,
    actual_settings: isRecord(value.actual_settings) ? value.actual_settings : {},
  };
}

/** take 在 run 中的輸出名稱；舊資料沒有紀錄時用單張的預設名稱。 */
export function takeOutputs(take: Pick<StudioImageTake, "params_snapshot">): { image: string; image_white: string | null } {
  return takeSnapshot(take)?.outputs ?? { image: OUTPUT_IMAGE, image_white: OUTPUT_WHITE };
}

/** 某個步驟（含）的所有上游步驟 id，依 pipeline 順序。 */
export function upstreamSteps(run: Pick<WireRun, "request">, stepId: string): string[] {
  const steps = run.request.pipeline.steps;
  const byId = new Map(steps.map((step) => [step.step_id, step]));
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const step = byId.get(id);
    if (!step) return;
    seen.add(id);
    for (const binding of Object.values(step.inputs)) if ("from_step" in binding) visit(binding.from_step);
  };
  visit(stepId);
  return steps.filter((step) => seen.has(step.step_id)).map((step) => step.step_id);
}

/** 這張圖的步驟（輸出步驟的上游；白底輸出若來自別的步驟一併納入）。 */
export function takeStepIds(run: Pick<WireRun, "request">, take: Pick<StudioImageTake, "params_snapshot">): string[] {
  const outputs = takeOutputs(take);
  const ids = new Set<string>();
  for (const key of [outputs.image, outputs.image_white]) {
    const ref = key ? run.request.pipeline.outputs[key] : undefined;
    if (ref) for (const id of upstreamSteps(run, ref.from_step)) ids.add(id);
  }
  return run.request.pipeline.steps.map((step) => step.step_id).filter((id) => ids.has(id));
}

/** 批次後綴（image_2 → "_2"、image → ""）。 */
export function outputSuffix(outputKey: string): string {
  return /(_\d+)$/.exec(outputKey)?.[1] ?? "";
}

function elapsedMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function readAsset(run: WireRun, key: string | null): ImageAsset | null {
  const ref = key ? run.request.pipeline.outputs[key] : undefined;
  if (!ref) return null;
  const step = parseRunStep(ref.from_step, run.steps[ref.from_step]);
  const value = step.outputs[ref.output];
  return step.state === "succeeded" && value && "value" in value ? asImageAsset(value.value) : null;
}

export interface ImageTakeOutcome {
  state: ImageTakeState;
  image: ImageAsset | null;
  image_white: ImageAsset | null;
  error: ApiErrorBody | null;
  /** Each template step's time (batch suffix removed) and `total` (takeTotal); null without timestamps, never 0. */
  timings_ms: Record<string, number | null>;
}

/** The key of a take's total in timings_ms; every other key is a template step. */
const TOTAL = "total";

export interface TakeTotal {
  /** Sum of the take's own step times; null when not measured. */
  ms: number | null;
  /** The take's steps (template ids) without a start or end time: why the total is not measured. */
  missing: string[];
}

/**
 * A take's total time: the sum of its own steps' times (a step the batch shares, such as text conditioning, counts in
 * every take of the batch). Never the run's wall time, which in a batch also covers the other images' steps. Not
 * measured when one of its steps has no time, or when no step time was recorded; a stored `total` is not read (older
 * versions stored the run's wall time there).
 */
export function takeTotal(timings: Readonly<Record<string, number | null | undefined>>): TakeTotal {
  const steps = Object.entries(timings).filter(([key]) => key !== TOTAL);
  const missing = steps.flatMap(([key, ms]) => (typeof ms === "number" && Number.isFinite(ms) ? [] : [key]));
  if (steps.length === 0 || missing.length > 0) return { ms: null, missing };
  return { ms: steps.reduce((sum, [, ms]) => sum + (ms ?? 0), 0), missing };
}

export function imageTakeOutcome(run: WireRun, take: Pick<StudioImageTake, "params_snapshot">): ImageTakeOutcome {
  const outputs = takeOutputs(take);
  const suffix = outputSuffix(outputs.image);
  const views: RunStepView[] = takeStepIds(run, take).map((id) => parseRunStep(id, run.steps[id]));
  const timings: Record<string, number | null> = {};
  for (const view of views) {
    const base = suffix && view.step_id.endsWith(suffix) ? view.step_id.slice(0, -suffix.length) : view.step_id;
    timings[base] = elapsedMs(view.started_at, view.finished_at);
  }
  // A take of a batch is written as soon as its own steps end (reconcile.ts), so its total cannot wait for the run
  timings[TOTAL] = takeTotal(timings).ms;
  const image = readAsset(run, outputs.image);
  if (image) return { state: "succeeded", image, image_white: readAsset(run, outputs.image_white), error: null, timings_ms: timings };
  if (run.state === "running") return { state: "rendering", image: null, image_white: null, error: null, timings_ms: timings };
  const state: ImageTakeState = run.state === "cancelled" ? "cancelled" : run.state === "interrupted" ? "interrupted" : "failed";
  const failed = views.find((view) => view.error);
  const error = failed?.error ?? run.error ?? (run.state === "succeeded" ? { code: "OUTPUT_MISSING", message: t("run 成功但找不到這張圖的輸出") } : null);
  return { state, image: null, image_white: null, error, timings_ms: timings };
}

/** run 狀態上的 preview（RunStepPreview）；缺必要欄位或網址不是主控路徑時 null（不顯示，不猜）。 */
export function asPreview(value: unknown): RunStepPreview | null {
  if (!isRecord(value) || typeof value.url !== "string" || !value.url.startsWith("/api/runs/")) return null;
  const n = (key: string): number | null => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  const seq = n("seq");
  const step = n("step");
  const total = n("total");
  if (seq === null || step === null || total === null || total < 1) return null;
  return {
    seq,
    step,
    total,
    width: n("width") ?? 0,
    height: n("height") ?? 0,
    media_type: value.media_type === "image/png" ? "image/png" : "image/jpeg",
    size_bytes: n("size_bytes") ?? 0,
    note: typeof value.note === "string" && value.note ? value.note : null,
    at: typeof value.at === "string" ? value.at : "",
    url: value.url,
  };
}

/**
 * 這張圖執行中步驟的最新中間預覽；沒有時 null。preview 只在步驟 running 時存在（步驟結束就沒有，最終輸出才是結果）。
 * 同一張圖有多個步驟帶預覽時取時間最新的一張。
 */
export function takePreview(run: WireRun | undefined, take: Pick<StudioImageTake, "params_snapshot">): (RunStepPreview & { stepId: string }) | null {
  if (!run || run.state !== "running") return null;
  let best: (RunStepPreview & { stepId: string }) | null = null;
  for (const id of takeStepIds(run, take)) {
    const raw = run.steps[id];
    if (!isRecord(raw) || raw.state !== "running") continue;
    const preview = asPreview(raw.preview);
    if (preview && (!best || preview.at > best.at || (preview.at === best.at && preview.seq > best.seq))) best = { ...preview, stepId: id };
  }
  return best;
}

export interface TakeStage {
  stepId: string;
  role: ImageStepRole | null;
  label: string;
  state: RunStepView["state"];
  startedAt: string | null;
  finishedAt: string | null;
  error: ApiErrorBody | null;
}

/** 這張圖的各階段（pipeline 順序）；角色依步驟元件的 provider（lookup），查不到時用範本步驟 id。 */
export function takeStages(run: WireRun, take: Pick<StudioImageTake, "params_snapshot">, lookup: (nodeId: string, componentId: string) => string | null): TakeStage[] {
  const suffix = outputSuffix(takeOutputs(take).image);
  const defs = new Map(run.request.pipeline.steps.map((step) => [step.step_id, step]));
  return takeStepIds(run, take).map((id) => {
    const view = parseRunStep(id, run.steps[id]);
    const def = defs.get(id);
    const provider = def ? lookup(view.node_id ?? def.node_id, view.component_id ?? def.component_id) : null;
    const role = provider ? (ROLE_BY_PROVIDER[provider] ?? null) : null;
    const base = suffix && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
    return { stepId: id, role, label: role ? ROLE_LABELS[role] : base, state: view.state, startedAt: view.started_at, finishedAt: view.finished_at, error: view.error };
  });
}
