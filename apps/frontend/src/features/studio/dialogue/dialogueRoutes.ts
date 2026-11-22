// The speech tools of the Captions panel find their components here: a transcription component (facts.transcription)
// and a speech (TTS) component (facts.studio_speech). A saved pipeline that runs one of them is preferred (it carries the
// owner's chosen settings); without one, a one-step request is built from the component itself. Neither needs the
// component to be loaded: an on-demand component starts on first use, which the panel announces with its load time.
import { componentAvailability, type CatalogIndex, type ComponentEntry } from "@/api/catalog";
import type { ComponentDescriptor, Port } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

export const TRANSCRIPT_TYPE = "speech.transcript.v1";

export interface TranscribeRoute {
  pipeline: WirePipeline;
  entry: ComponentEntry;
  /** Pipeline input that takes the media file, by media family. */
  inputs: { video: string | null; audio: string | null };
  /** Pipeline output that carries the transcript. */
  outputKey: string;
}

export interface SpeechRoute {
  pipeline: WirePipeline;
  entry: ComponentEntry;
  stepId: string;
  /** Pipeline input that takes the line's text. */
  textInput: string;
  /** Pipeline output that carries the audio. */
  audioKey: string;
  /** Parameter names (facts.studio_speech) with the values the schema allows and the default of the route. */
  voice: SpeechChoice | null;
  language: SpeechChoice | null;
}

export interface SpeechChoice {
  parameter: string;
  options: readonly string[];
  fallback: string;
}

/** Whether the component can take the job now, or what the owner waits for first. */
export type Readiness =
  | { kind: "ready" }
  | { kind: "cold"; seconds: number }
  | { kind: "loading"; seconds: number }
  | { kind: "blocked"; reason: string };

/** Typical first-load times, used until the component has a measured load time (cost profile load_ms). */
const LOAD_SECONDS = { transcribe: 20, speech: 60 } as const;

/**
 * Whether the component can take the job now (componentAvailability): a ready one starts at once, an on-demand one
 * (load_policy on_demand) is loaded by the Controller when the step needs it, any other is refused with a reason.
 * measuredMs is the component's measured load time, null while it has none.
 */
export function readiness(entry: ComponentEntry, kind: keyof typeof LOAD_SECONDS, measuredMs: number | null): Readiness {
  if (entry.node.stale) return { kind: "blocked", reason: t("執行語音元件的主機目前離線") };
  const seconds = measuredMs !== null && measuredMs > 0 ? Math.max(1, Math.round(measuredMs / 1000)) : LOAD_SECONDS[kind];
  switch (componentAvailability(entry.descriptor)) {
    case "ready":
      return { kind: "ready" };
    case "on_use":
      return entry.descriptor.state === "loading" ? { kind: "loading", seconds } : { kind: "cold", seconds };
    case "unavailable":
      return {
        kind: "blocked",
        reason: entry.descriptor.state === "error"
          ? t("語音元件「{label}」載入失敗；請到「元件」查看", { label: entry.descriptor.label })
          : t("語音元件「{label}」尚未啟動；請到「元件」啟動，或把它設為用到才載入", { label: entry.descriptor.label }),
      };
  }
}

/** One line for the panel: what happens before the job starts. Null when nothing needs saying. */
export function readinessNote(state: Readiness): string | null {
  if (state.kind === "cold") return t("首次使用需要載入模型（約 {seconds} 秒）", { seconds: state.seconds });
  if (state.kind === "loading") return t("正在載入模型，約 {seconds} 秒", { seconds: state.seconds });
  if (state.kind === "blocked") return state.reason;
  return null;
}

/** Healthy entries first: ready, then loaded on use, then the rest; an offline Node last. */
function rank(entry: ComponentEntry): number {
  if (entry.node.stale) return 3;
  return { ready: 0, on_use: 1, unavailable: 2 }[componentAvailability(entry.descriptor)];
}

function connectedInputs(pipeline: WirePipeline, stepId: string): Map<string, string> {
  const step = pipeline.steps.find((item) => item.step_id === stepId);
  const out = new Map<string, string>();
  for (const [port, binding] of Object.entries(step?.inputs ?? {})) if ("from_input" in binding) out.set(port, binding.from_input);
  return out;
}

/** A one-step request built from the component, for when no saved pipeline runs it. */
function adHoc(entry: ComponentEntry, id: string, label: string, stepId: string): WirePipeline {
  const { descriptor } = entry;
  return {
    pipeline_id: id,
    label,
    inputs: descriptor.inputs.map((port: Port) => ({ ...port })),
    steps: [{
      step_id: stepId, node_id: descriptor.node_id, component_id: descriptor.component_id,
      inputs: Object.fromEntries(descriptor.inputs.map((port) => [port.name, { from_input: port.name }])),
      parameters: {},
    }],
    outputs: Object.fromEntries(descriptor.outputs.map((port) => [port.name, { from_step: stepId, output: port.name }])),
  };
}

export function transcribeRoute(pipelines: readonly WirePipeline[], index: CatalogIndex): TranscribeRoute | null {
  const isTranscriber = (descriptor: ComponentDescriptor) => descriptor.facts?.["transcription"] === TRANSCRIPT_TYPE;
  const saved = pipelines.flatMap((pipeline): TranscribeRoute[] => {
    if (pipeline.steps.length !== 1) return [];
    const step = pipeline.steps[0];
    const entry = step ? index.entry(step.node_id, step.component_id) : null;
    if (!step || !entry || !isTranscriber(entry.descriptor)) return [];
    const wired = connectedInputs(pipeline, step.step_id);
    const inputFor = (type: string) => {
      const port = entry.descriptor.inputs.find((item) => item.type_id === type && wired.has(item.name));
      const name = port ? wired.get(port.name) : undefined;
      return name !== undefined && pipeline.inputs.some((item) => item.name === name && item.transport !== "inline") ? name : null;
    };
    const transcript = entry.descriptor.outputs.find((port) => port.type_id === TRANSCRIPT_TYPE);
    const outputKey = Object.entries(pipeline.outputs).find(([, edge]) => edge.from_step === step.step_id && edge.output === transcript?.name)?.[0];
    const inputs = { video: inputFor("media.video.v1"), audio: inputFor("media.audio.v1") };
    return outputKey !== undefined && (inputs.video !== null || inputs.audio !== null) ? [{ pipeline, entry, inputs, outputKey }] : [];
  });
  const built = index.entries.filter((entry) => isTranscriber(entry.descriptor)).flatMap((entry): TranscribeRoute[] => {
    const transcript = entry.descriptor.outputs.find((port) => port.type_id === TRANSCRIPT_TYPE);
    if (!transcript) return [];
    const port = (type: string) => entry.descriptor.inputs.find((item) => item.type_id === type && item.transport !== "inline")?.name ?? null;
    return [{ pipeline: adHoc(entry, "studio-transcribe", t("辨識台詞"), "transcribe"), entry, inputs: { video: port("media.video.v1"), audio: port("media.audio.v1") }, outputKey: transcript.name }];
  });
  return [...saved, ...built].sort((a, b) => rank(a.entry) - rank(b.entry))[0] ?? null;
}

function choice(schema: unknown, parameter: unknown, preset: unknown): SpeechChoice | null {
  if (typeof parameter !== "string" || !isRecord(schema)) return null;
  const properties = schema["properties"];
  const spec = isRecord(properties) ? properties[parameter] : undefined;
  if (!isRecord(spec) || !Array.isArray(spec["enum"])) return null;
  const options = spec["enum"].filter((item): item is string => typeof item === "string");
  if (options.length === 0) return null;
  const preferred = typeof preset === "string" && options.includes(preset) ? preset : spec["default"];
  return { parameter, options, fallback: typeof preferred === "string" && options.includes(preferred) ? preferred : (options[0] ?? "") };
}

export function speechRoute(pipelines: readonly WirePipeline[], index: CatalogIndex): SpeechRoute | null {
  const facts = (descriptor: ComponentDescriptor) => {
    const value = descriptor.facts?.["studio_speech"];
    return isRecord(value) && value["version"] === 1 && typeof value["text"] === "string" && typeof value["audio"] === "string" ? value : null;
  };
  const make = (pipeline: WirePipeline, entry: ComponentEntry, stepId: string): SpeechRoute | null => {
    const fact = facts(entry.descriptor);
    if (!fact) return null;
    const textInput = connectedInputs(pipeline, stepId).get(String(fact["text"]));
    if (textInput === undefined || !pipeline.inputs.some((port) => port.name === textInput && port.type_id === "text.prompt.v1" && port.transport !== "file")) return null;
    const audioKey = Object.entries(pipeline.outputs).find(([, edge]) => edge.from_step === stepId && edge.output === fact["audio"])?.[0];
    if (audioKey === undefined) return null;
    const parameters = pipeline.steps.find((step) => step.step_id === stepId)?.parameters ?? {};
    const schema = entry.descriptor.settings.parameters_schema;
    const voiceName = fact["speaker"];
    const languageName = fact["language"];
    return {
      pipeline, entry, stepId, textInput, audioKey,
      voice: choice(schema, voiceName, typeof voiceName === "string" ? parameters[voiceName] : undefined),
      language: choice(schema, languageName, typeof languageName === "string" ? parameters[languageName] : undefined),
    };
  };
  const saved = pipelines.flatMap((pipeline) => {
    if (pipeline.steps.length !== 1) return [];
    const step = pipeline.steps[0];
    const entry = step ? index.entry(step.node_id, step.component_id) : null;
    const route = step && entry ? make(pipeline, entry, step.step_id) : null;
    return route ? [route] : [];
  });
  const built = index.entries.flatMap((entry) => {
    if (!facts(entry.descriptor)) return [];
    const route = make(adHoc(entry, "studio-dialogue-speech", t("台詞配音"), "synthesize"), entry, "synthesize");
    return route ? [route] : [];
  });
  return [...saved, ...built].sort((a, b) => rank(a.entry) - rank(b.entry))[0] ?? null;
}
