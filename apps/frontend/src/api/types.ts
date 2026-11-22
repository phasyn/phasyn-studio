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
  RunStepComponentLoad,
  RunStepPreview,
  SceneDocument,
  StudioWorkOrigin,
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
  recovery_policy?: "observe_only" | "retry_verified";
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
  studio_work?: StudioWorkOrigin;
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
  /**
   * 用到才載入（x-phasyn-extension）：步驟要用的 on_demand 元件還沒載入時，主控正在做什麼。phase=loading（state=running）＝
   * 正在載入模型；phase=waiting（state=waiting）＝暫時不能載入，reason／message 說明原因。呼叫送出後沒有這個欄位（null）。
   */
  component_load?: RunStepComponentLoad | null;
}

const STEP_STATES: readonly StepState[] = ["pending", "waiting", "running", "succeeded", "failed", "cancelled", "interrupted", "skipped"];

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isFileRef(value: unknown): value is FileRef {
  return (
    isRecord(value) &&
    typeof value["node_id"] === "string" &&
    typeof value["file_id"] === "string" &&
    typeof value["size_bytes"] === "number" &&
    typeof value["sha256"] === "string" &&
    typeof value["media_type"] === "string" &&
    isRecord(value["metadata"])
  );
}

export function asTypedValue(value: unknown): WireTypedValue | null {
  if (!isRecord(value) || typeof value["type_id"] !== "string") return null;
  if (isFileRef(value["file"])) return { type_id: value["type_id"], file: value["file"] };
  if (Object.hasOwn(value, "value")) return { type_id: value["type_id"], value: value["value"] };
  return null;
}

/** Every hand-written step input must bind to a pipeline input, a step output, or a typed literal. */
export function isWireBindings(value: unknown): value is Record<string, WireBinding> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((binding) => isRecord(binding) && (
    typeof binding["from_input"] === "string" || (typeof binding["from_step"] === "string" && typeof binding["output"] === "string")
      || asTypedValue(binding["literal"]) !== null
  ));
}

export function typedFile(value: WireTypedValue): FileRef | null {
  return "file" in value ? value.file : null;
}

export function asApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!isRecord(value) || typeof value["code"] !== "string") return null;
  return {
    code: value["code"],
    message: typeof value["message"] === "string" ? value["message"] : "",
    ...(isRecord(value["details"]) ? { details: value["details"] } : {}),
    remote_outcome_unknown: value["remote_outcome_unknown"] === true,
  };
}

function isObjectMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

function asEffectiveContext(value: unknown): EffectiveContext | null {
  if (!isRecord(value)) return null;
  const { requested, effective, observed, stored_revision, loaded_revision, expanded_parts, config_digest, model_identity, runtime_identity } = value;
  if (!isRecord(requested) || !isRecord(effective) || !isRecord(observed) || !isRecord(model_identity) || !isRecord(runtime_identity)
    || !isInt(stored_revision) || !(loaded_revision === null || isInt(loaded_revision)) || typeof config_digest !== "string" || !isObjectMap(expanded_parts)) return null;
  return { requested, effective, observed, stored_revision, loaded_revision, expanded_parts, config_digest, model_identity, runtime_identity };
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

const LOAD_REASONS: readonly RunStepComponentLoad["reason"][] = ["loading", "exclusive_busy", "exclusive_resident", "exclusive_reserved", "device_busy", "stopping"];

/** Run.steps[step_id].component_load（x-phasyn-extension）；格式不符 → null，不猜值。 */
export function asRunStepComponentLoad(value: unknown): RunStepComponentLoad | null {
  if (!isRecord(value)) return null;
  const { phase, reason, message, component_id, holders, since, estimated_load_ms } = value;
  if (phase !== "loading" && phase !== "waiting") return null;
  const knownReason = LOAD_REASONS.find((candidate) => candidate === reason);
  if (knownReason === undefined || typeof message !== "string" || typeof component_id !== "string" || typeof since !== "string") return null;
  return {
    phase,
    reason: knownReason,
    message,
    component_id,
    holders: Array.isArray(holders) ? holders.filter((item): item is string => typeof item === "string") : [],
    since,
    estimated_load_ms: typeof estimated_load_ms === "number" ? estimated_load_ms : null,
  };
}

/** Run.steps[step_id] 的寬鬆 object → 具名欄位；缺欄位以 null 表示，不猜值。 */
export function parseRunStep(stepId: string, raw: unknown): RunStepView {
  const record = isRecord(raw) ? raw : {};
  const state = STEP_STATES.find((candidate) => candidate === record["state"]) ?? "unknown";
  return {
    step_id: stepId,
    state,
    node_id: strOrNull(record["node_id"]),
    component_id: strOrNull(record["component_id"]),
    call_id: strOrNull(record["call_id"]),
    recording_id: strOrNull(record["recording_id"]),
    started_at: strOrNull(record["started_at"]),
    finished_at: strOrNull(record["finished_at"]),
    outputs: asTypedValueMap(record["outputs"]),
    error: asApiErrorBody(record["error"]),
    remote_outcome_unknown: record["remote_outcome_unknown"] === true,
    settings: asEffectiveContext(record["settings"]),
    load_revision: typeof record["load_revision"] === "number" ? record["load_revision"] : null,
    preview: state === "running" ? asRunStepPreview(record["preview"]) : null,
    component_load: state === "running" || state === "waiting" ? asRunStepComponentLoad(record["component_load"]) : null,
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
  if (typeof value["latent_id"] !== "string" || typeof value["blob_sha256"] !== "string" || typeof value["manifest_sha256"] !== "string") return null;
  if (!isFileRef(value["manifest_file"])) return null;
  return { latent_id: value["latent_id"], blob_sha256: value["blob_sha256"], manifest_sha256: value["manifest_sha256"], manifest_file: value["manifest_file"] };
}

const ASSET_KINDS: readonly Asset["kind"][] = ["preview", "final", "video", "audio"];

export function asAsset(value: unknown): Asset | null {
  if (!isRecord(value)) return null;
  const kind = ASSET_KINDS.find((candidate) => candidate === value["kind"]);
  if (typeof value["asset_id"] !== "string" || kind === undefined) return null;
  if (!isFileRef(value["file"])) return null;
  return {
    asset_id: value["asset_id"],
    kind,
    file: value["file"],
    source_latent: asLatentRef(value["source_latent"]),
    frame_count: typeof value["frame_count"] === "number" ? value["frame_count"] : 0,
    fps: isRecord(value["fps"]) && typeof value["fps"]["num"] === "number" && typeof value["fps"]["den"] === "number" ? { num: value["fps"]["num"], den: value["fps"]["den"] } : null,
    width: typeof value["width"] === "number" ? value["width"] : 0,
    height: typeof value["height"] === "number" ? value["height"] : 0,
    complete: value["complete"] === true,
    actual_settings: isRecord(value["actual_settings"]) ? value["actual_settings"] : {},
  };
}

export function asCaptionPair(value: unknown): CaptionPair | null {
  if (!isRecord(value)) return null;
  const { training_caption, generation_prompt, source, scene_recording_id, include_uncertain, language } = value;
  if (typeof training_caption !== "string" || typeof generation_prompt !== "string" || !isFileRef(source)
    || !(scene_recording_id === null || typeof scene_recording_id === "string") || typeof include_uncertain !== "boolean" || typeof language !== "string") return null;
  return { training_caption, generation_prompt, source, scene_recording_id, include_uncertain, language };
}

function listOf(value: unknown, matches: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(matches);
}

const stringItem = (value: unknown): boolean => typeof value === "string";

function sceneEntity(value: unknown): boolean {
  return isRecord(value) && typeof value["entity_id"] === "string" && typeof value["kind"] === "string" && typeof value["description"] === "string";
}

function sceneEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { event_id, start_seconds, end_seconds, description, entity_ids, evidence_frame_ids, certainty } = value;
  return typeof event_id === "string" && typeof start_seconds === "number" && typeof end_seconds === "number" && typeof description === "string"
    && listOf(entity_ids, stringItem) && listOf(evidence_frame_ids, stringItem) && (certainty === "observed" || certainty === "uncertain");
}

function frameEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { frame_id, source_pts, time_base, time_seconds, file } = value;
  return typeof frame_id === "string" && typeof source_pts === "number" && typeof time_seconds === "number"
    && isRecord(time_base) && isInt(time_base["num"]) && isInt(time_base["den"]) && (file === null || isFileRef(file));
}

function isSceneDocument(value: unknown): value is SceneDocument {
  if (!isRecord(value)) return false;
  const { schema_version, source, duration_seconds, initial_state, final_state, camera, entities, events, evidence, unknowns, generation_edits, caption_model } = value;
  return schema_version === "4.0" && isFileRef(source) && typeof duration_seconds === "number" && typeof initial_state === "string" && typeof final_state === "string" && typeof camera === "string"
    && listOf(entities, sceneEntity) && listOf(events, sceneEvent) && listOf(evidence, frameEvidence) && listOf(unknowns, stringItem) && listOf(generation_edits, stringItem) && isRecord(caption_model);
}

export function asSceneDocument(value: unknown): SceneDocument | null {
  return isSceneDocument(value) ? value : null;
}

/** 元件識別：node_id + component_id 才是 instance identity。 */
export function instanceKey(nodeId: string, componentId: string): string {
  return `${nodeId}::${componentId}`;
}

export function descriptorKey(descriptor: Pick<ComponentDescriptor, "node_id" | "component_id">): string {
  return instanceKey(descriptor.node_id, descriptor.component_id);
}
