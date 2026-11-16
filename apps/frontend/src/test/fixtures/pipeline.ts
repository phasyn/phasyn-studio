// Builders for pipelines (component compositions) and runs as the Controller returns them.
import type { ApiErrorBody, FileRef, Port } from "@/api/generated/contracts";
import type { RunState, StepState, WireBinding, WirePipeline, WireRun, WireStep, WireTypedValue } from "@/api/types";
import { FIXED_TIME, NODE_A_ID, uid } from "../ids";

export const fromInput = (name: string): WireBinding => ({ from_input: name });
export const fromStep = (step_id: string, output: string): WireBinding => ({ from_step: step_id, output });

export function step(step_id: string, node_id: string, component_id: string, inputs: Record<string, WireBinding> = {}, parameters: Record<string, unknown> = {}): WireStep {
  return { step_id, node_id, component_id, inputs, parameters };
}

export interface PipelineOptions {
  label?: string;
  inputs?: Port[];
  outputs?: WirePipeline["outputs"];
}

export function pipeline(pipeline_id: string, steps: WireStep[], options: PipelineOptions = {}): WirePipeline {
  return { pipeline_id, label: options.label ?? pipeline_id, inputs: options.inputs ?? [], steps, outputs: options.outputs ?? {} };
}

/** A FileRef on Node A with placeholder hash and size. */
export function fileRef(file_id: string, overrides: Partial<FileRef> = {}): FileRef {
  return { node_id: NODE_A_ID, file_id, size_bytes: 1, sha256: "0".repeat(64), media_type: "application/octet-stream", metadata: {}, ...overrides };
}

export interface StepRecord {
  state: StepState;
  node_id: string | null;
  component_id: string | null;
  call_id: string | null;
  recording_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  outputs: Record<string, WireTypedValue>;
  error: ApiErrorBody | null;
  remote_outcome_unknown: boolean;
  settings: unknown;
  load_revision: number | null;
}

/** One entry of `run.steps` (the runner's step-state object). */
export function stepRecord(state: StepState, overrides: Partial<StepRecord> = {}): StepRecord {
  const started = state === "pending" || state === "waiting" || state === "skipped" ? null : FIXED_TIME;
  const finished = state === "pending" || state === "waiting" || state === "running" ? null : FIXED_TIME;
  return {
    state,
    node_id: null,
    component_id: null,
    call_id: null,
    recording_id: null,
    started_at: started,
    finished_at: finished,
    outputs: {},
    error: null,
    remote_outcome_unknown: false,
    settings: null,
    load_revision: null,
    ...overrides,
  };
}

export interface RunOptions {
  run_id?: string;
  state?: RunState;
  inputs?: Record<string, WireTypedValue>;
  label?: string;
  steps?: Record<string, StepRecord>;
  outputs?: Record<string, WireTypedValue>;
  recording_ids?: string[];
  error?: ApiErrorBody | null;
  created_at?: string;
  finished_at?: string | null;
}

/** A WireRun of `pipeline` (default: succeeded, `run_id` uid(1)). */
export function run(source: WirePipeline, options: RunOptions = {}): WireRun {
  const state = options.state ?? "succeeded";
  return {
    run_id: options.run_id ?? uid(1),
    state,
    request: { pipeline: source, inputs: options.inputs ?? {}, ...(options.label === undefined ? {} : { label: options.label }) },
    created_at: options.created_at ?? FIXED_TIME,
    finished_at: options.finished_at === undefined ? (state === "running" ? null : FIXED_TIME) : options.finished_at,
    steps: options.steps ?? {},
    outputs: options.outputs ?? {},
    recording_ids: options.recording_ids ?? [],
    error: options.error ?? null,
  };
}
