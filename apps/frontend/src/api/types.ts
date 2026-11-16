// 產生型別之上的 wire 細化：TypedValue.value 是任意 JSON（產生器誤收斂為 object）、Run.steps 是寬鬆 object。
// 這裡只做結構判斷，不改變契約欄位名稱。
import type {
  ApiErrorBody,
  Asset,
  CaptionPair,
  ComponentDescriptor,
  EffectiveContext,
  FileRef,
  LatentRef,
  Origin,
  Port,
  RecorderConfig,
  RunStepPreview,
  SceneDocument,
} from "./generated/contracts";
import { isRecord } from "@/lib/json";

export type WireTypedValue = { type_id: string; value: unknown } | { type_id: string; file: FileRef };

export type WireBinding = { from_input: string } | { from_step: string; output: string } | { literal: WireTypedValue };

export interface WireStep {
  step_id: string;
  node_id: string;
  component_id: string;
  inputs: Record<string, WireBinding>;
  parameters: Record<string, unknown>;
  load_revision?: number | null;
  recording_override?: RecorderConfig;
  timeout_seconds?: number;
}

export interface WirePipeline {
  pipeline_id: string;
  label: string;
  inputs: Port[];
  steps: WireStep[];
  outputs: Record<string, { from_step: string; output: string }>;
}

export interface RunRequestBody {
  pipeline: WirePipeline;
  inputs: Record<string, WireTypedValue>;
  label?: string;
  origin?: Origin;
  /** proxy: a small CPU rendition that takes no run slot (RunRequest.purpose). */
  purpose?: "proxy";
}

export type RunState = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type StepState = "pending" | "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "skipped";

export interface WireRun {
  run_id: string;
  state: RunState;
  request: RunRequestBody;
  created_at: string;
  finished_at: string | null;
  steps: Record<string, unknown>;
  outputs: Record<string, unknown>;
  recording_ids: string[];
  error: ApiErrorBody | null;
  /** 封存時間（x-phasyn-extension）；未封存＝null 或沒有這個欄位。 */
  archived_at?: string | null;
}

export interface RunPage {
  items: WireRun[];
  next_cursor: string | null;
}

export interface RunStepView {
  step_id: string;
  state: StepState | "unknown";
  node_id: string | null;
  component_id: string | null;
  call_id: string | null;
  recording_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  outputs: Record<string, WireTypedValue>;
  error: ApiErrorBody | null;
  remote_outcome_unknown: boolean;
  settings: EffectiveContext | null;
  load_revision: number | null;
  /** 執行中步驟最新的中間預覽（非最終結果）；不是 running 或沒有 → null。 */
  preview: RunStepPreview | null;
}

const STEP_STATES = new Set<string>(["pending", "waiting", "running", "succeeded", "failed", "cancelled", "interrupted", "skipped"]);

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isFileRef(value: unknown): value is FileRef {
  return (
    isRecord(value) &&
    typeof value.node_id === "string" &&
    typeof value.file_id === "string" &&
    typeof value.size_bytes === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.media_type === "string" &&
    isRecord(value.metadata)
  );
}

export function asTypedValue(value: unknown): WireTypedValue | null {
  if (!isRecord(value) || typeof value.type_id !== "string") return null;
  if (isFileRef(value.file)) return { type_id: value.type_id, file: value.file };
  if (Object.hasOwn(value, "value")) return { type_id: value.type_id, value: value.value };
  return null;
}

export function typedFile(value: WireTypedValue): FileRef | null {
  return "file" in value ? value.file : null;
}

export function asApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  return {
    code: value.code,
    message: typeof value.message === "string" ? value.message : "",
    details: isRecord(value.details) ? value.details : undefined,
    remote_outcome_unknown: value.remote_outcome_unknown === true,
  };
}

function asEffectiveContext(value: unknown): EffectiveContext | null {
  if (!isRecord(value) || !isRecord(value.effective)) return null;
  return value as unknown as EffectiveContext;
}

export function asTypedValueMap(value: unknown): Record<string, WireTypedValue> {
  const out: Record<string, WireTypedValue> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const typed = asTypedValue(raw);
    if (typed) out[key] = typed;
  }
  return out;
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** Run.steps[step_id].preview（x-phasyn-extension）：只在 running 時出現；格式不符 → null，不猜值。 */
export function asRunStepPreview(value: unknown): RunStepPreview | null {
  if (!isRecord(value)) return null;
  const { seq, step, total, width, height, media_type, size_bytes, note, at, url } = value;
  if (!isInt(seq) || !isInt(step) || !isInt(total) || !isInt(width) || !isInt(height) || !isInt(size_bytes)) return null;
  if (media_type !== "image/jpeg" && media_type !== "image/png") return null;
  if (typeof at !== "string" || typeof url !== "string" || !url.startsWith("/api/runs/")) return null;
  return { seq, step, total, width, height, media_type, size_bytes, note: typeof note === "string" ? note : null, at, url };
}

/** Run.steps[step_id] 的寬鬆 object → 具名欄位；缺欄位以 null 表示，不猜值。 */
export function parseRunStep(stepId: string, raw: unknown): RunStepView {
  const record = isRecord(raw) ? raw : {};
  const state = typeof record.state === "string" && STEP_STATES.has(record.state) ? (record.state as StepState) : "unknown";
  return {
    step_id: stepId,
    state,
    node_id: strOrNull(record.node_id),
    component_id: strOrNull(record.component_id),
    call_id: strOrNull(record.call_id),
    recording_id: strOrNull(record.recording_id),
    started_at: strOrNull(record.started_at),
    finished_at: strOrNull(record.finished_at),
    outputs: asTypedValueMap(record.outputs),
    error: asApiErrorBody(record.error),
    remote_outcome_unknown: record.remote_outcome_unknown === true,
    settings: asEffectiveContext(record.settings),
    load_revision: typeof record.load_revision === "number" ? record.load_revision : null,
    preview: state === "running" ? asRunStepPreview(record.preview) : null,
  };
}

export function runSteps(run: WireRun): RunStepView[] {
  const order = run.request.pipeline.steps.map((step) => step.step_id);
  const known = new Set(order);
  const extra = Object.keys(run.steps).filter((id) => !known.has(id));
  return [...order, ...extra].map((id) => parseRunStep(id, run.steps[id]));
}

export function asLatentRef(value: unknown): LatentRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.latent_id !== "string" || typeof value.blob_sha256 !== "string" || typeof value.manifest_sha256 !== "string") return null;
  if (!isFileRef(value.manifest_file)) return null;
  return value as unknown as LatentRef;
}

const ASSET_KINDS = new Set(["preview", "final", "video", "audio"]);

export function asAsset(value: unknown): Asset | null {
  if (!isRecord(value)) return null;
  if (typeof value.asset_id !== "string" || typeof value.kind !== "string" || !ASSET_KINDS.has(value.kind)) return null;
  if (!isFileRef(value.file)) return null;
  return {
    asset_id: value.asset_id,
    kind: value.kind as Asset["kind"],
    file: value.file,
    source_latent: asLatentRef(value.source_latent),
    frame_count: typeof value.frame_count === "number" ? value.frame_count : 0,
    fps: isRecord(value.fps) && typeof value.fps.num === "number" && typeof value.fps.den === "number" ? { num: value.fps.num, den: value.fps.den } : null,
    width: typeof value.width === "number" ? value.width : 0,
    height: typeof value.height === "number" ? value.height : 0,
    complete: value.complete === true,
    actual_settings: isRecord(value.actual_settings) ? value.actual_settings : {},
  };
}

export function asCaptionPair(value: unknown): CaptionPair | null {
  if (!isRecord(value) || typeof value.training_caption !== "string" || typeof value.generation_prompt !== "string") return null;
  return value as unknown as CaptionPair;
}

export function asSceneDocument(value: unknown): SceneDocument | null {
  if (!isRecord(value)) return null;
  if (typeof value.duration_seconds !== "number" || !Array.isArray(value.events) || !Array.isArray(value.entities)) return null;
  if (!isFileRef(value.source)) return null;
  return value as unknown as SceneDocument;
}

/** 元件識別：node_id + component_id 才是 instance identity。 */
export function instanceKey(nodeId: string, componentId: string): string {
  return `${nodeId}::${componentId}`;
}

export function descriptorKey(descriptor: Pick<ComponentDescriptor, "node_id" | "component_id">): string {
  return instanceKey(descriptor.node_id, descriptor.component_id);
}
