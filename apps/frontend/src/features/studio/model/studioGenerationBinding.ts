import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { t } from "@/i18n";
import { isListed, isRecord } from "@/lib/json";
import { H3_RULES, H3_STUDIO_PROVIDERS, isH3Provider } from "./providerTraits";
import type { RouteStep, StudioRoute } from "./routes";

const REQUIRED = ["width", "height", "frames", "seed"] as const;
const OPTIONAL = ["steps", "video_shift", "audio_shift"] as const;
const FIELDS = [...REQUIRED, ...OPTIONAL, "fps_num", "fps_den"] as const;
type Field = (typeof FIELDS)[number];

interface ParameterBinding {
  field: Field;
  name: string;
  integer: boolean;
  schema: Record<string, unknown>;
}

export interface StudioGenerationBinding {
  maxFps: number;
  fixedFps: { num: number; den: number } | null;
  byStep: ReadonlyMap<string, readonly ParameterBinding[]>;
  firstFrame: { input: string; nodeId: string } | null;
}

export type DeclaredGeneration = { valid: true; binding: StudioGenerationBinding } | { valid: false; problem: string };

function outputAncestors(pipeline: WirePipeline, finalStep: string): Set<string> {
  const steps = new Map(pipeline.steps.map((step) => [step.step_id, step]));
  const pending = [finalStep];
  const result = new Set<string>();
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (result.has(id)) continue;
    result.add(id);
    const step = steps.get(id);
    if (step) for (const input of Object.values(step.inputs)) if ("from_step" in input) pending.push(input.from_step);
  }
  return result;
}

function allowsPort(port: { type_id: string; transport: string } | undefined, type: string, transport: string): boolean {
  return port?.type_id === type && (port.transport === transport || port.transport === "either");
}

function declarationProblem(step: string, field: string): DeclaredGeneration {
  return { valid: false, problem: t("Studio 生成宣告無效：請檢查步驟 {step} 的 {field}", { step, field }) };
}

/** Discover explicit bindings only on the graph that actually produces the selected film. */
export function declaredGeneration(pipeline: WirePipeline, steps: readonly RouteStep[], final: string, prompt: string): DeclaredGeneration | null {
  const declared = steps.filter(({ slot }) => Object.hasOwn(slot.component?.facts ?? {}, "studio_generation"));
  if (!declared.length) return null;
  const ancestors = outputAncestors(pipeline, final);
  if (steps.some(({ providerId }) => providerId != null && H3_STUDIO_PROVIDERS.has(providerId))) {
    return { valid: false, problem: t("Studio 生成宣告與 H3 專用步驟不能混用") };
  }
  const receivesPrompt = steps.some(({ step, slot }) => ancestors.has(step.step_id) && Object.entries(step.inputs).some(([name, edge]) =>
    "from_input" in edge && edge.from_input === prompt && allowsPort(slot.component?.inputs.find((port) => port.name === name), "text.prompt.v1", "inline")));
  if (!receivesPrompt || !allowsPort(pipeline.inputs.find((port) => port.name === prompt), "text.prompt.v1", "inline")) {
    return { valid: false, problem: t("Studio 的文字提示輸入必須連到成片輸出的上游步驟") };
  }
  const byStep = new Map<string, ParameterBinding[]>();
  const supplied = new Set<Field>();
  let maxFps = 240;
  let fixedFps: StudioGenerationBinding["fixedFps"] = null;
  let firstFrame: StudioGenerationBinding["firstFrame"] = null;
  for (const { step, slot } of declared) {
    const component = slot.component;
    const spec = component?.facts?.["studio_generation"];
    if (!component || !ancestors.has(step.step_id)) return declarationProblem(step.step_id, "studio_generation");
    if (!isRecord(spec) || spec["version"] !== 1 || Object.keys(spec).some((name) => !["version", "parameters", "first_frame", "fixed_fps", "max_fps"].includes(name))) {
      return declarationProblem(step.step_id, "version");
    }
    const fields = Object.hasOwn(spec, "parameters") ? spec["parameters"] : Object.hasOwn(spec, "fixed_fps") ? {} : null;
    if (!isRecord(fields)) return declarationProblem(step.step_id, "parameters");
    if (Object.hasOwn(fields, "fps_num") !== Object.hasOwn(fields, "fps_den")) return declarationProblem(step.step_id, "fps_num / fps_den");
    if (Object.hasOwn(spec, "max_fps")) {
      const maximum = spec["max_fps"];
      if (!Object.hasOwn(fields, "fps_num") || typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 1 || maximum > 240) return declarationProblem(step.step_id, "max_fps");
      maxFps = Math.min(maxFps, maximum);
    }
    if (Object.hasOwn(spec, "fixed_fps")) {
      const rate = spec["fixed_fps"];
      if (!isRecord(rate) || Object.keys(rate).length !== 2 || !validClock(rate["num"], rate["den"])) return declarationProblem(step.step_id, "fixed_fps");
      const candidate = { num: Number(rate["num"]), den: Number(rate["den"]) };
      if (fixedFps && !equalRate(fixedFps, candidate)) return declarationProblem(step.step_id, "fixed_fps");
      fixedFps = candidate;
    }
    const schemas = component.settings.parameters_schema["properties"];
    const aliases = new Set<string>();
    const bindings: ParameterBinding[] = [];
    for (const [field, name] of Object.entries(fields)) {
      if (!isListed(field, FIELDS) || typeof name !== "string" || !name || aliases.has(name) || !isRecord(schemas) || !Object.hasOwn(schemas, name)) {
        return declarationProblem(step.step_id, field);
      }
      const schema = schemas[name];
      if (!isRecord(schema)) return declarationProblem(step.step_id, name);
      const type = schema["type"];
      const shift = field === "video_shift" || field === "audio_shift";
      if (type !== "integer" && !(shift && type === "number")) return declarationProblem(step.step_id, name);
      if (!validLimits(schema)) return declarationProblem(step.step_id, name);
      aliases.add(name);
      supplied.add(field);
      bindings.push({ field, name, integer: type === "integer", schema });
    }
    byStep.set(step.step_id, bindings);
    if (Object.hasOwn(spec, "first_frame")) {
      const name = spec["first_frame"];
      const edge = typeof name === "string" && Object.hasOwn(step.inputs, name) ? step.inputs[name] : undefined;
      if (firstFrame || !edge || !("from_input" in edge) ||
        !allowsPort(component.inputs.find((port) => port.name === name), "media.image.v1", "file") ||
        !allowsPort(pipeline.inputs.find((port) => port.name === edge.from_input), "media.image.v1", "file")) {
        return declarationProblem(step.step_id, "first_frame");
      }
      firstFrame = { input: edge.from_input, nodeId: step.node_id };
    }
  }
  const missing = REQUIRED.filter((field) => !supplied.has(field));
  if (missing.length) return { valid: false, problem: t("成片輸出缺少 Studio 生成參數：{fields}", { fields: missing.join(", ") }) };
  if (fixedFps && supplied.has("fps_num")) return declarationProblem(final, "fixed_fps / fps_num");
  return { valid: true, binding: { byStep, firstFrame, fixedFps, maxFps } };
}

type GenerationValues = Record<Field, number | null>;

export function generationValues(project: StudioProject, shot: StudioShot, seed: number): GenerationValues {
  return { width: project.format.width, height: project.format.height, frames: shot.frames, seed, steps: shot.steps,
    video_shift: shot.video_shift, audio_shift: shot.audio_shift, fps_num: project.format.fps.num, fps_den: project.format.fps.den };
}

type Rate = StudioProject["format"]["fps"];

export function validClock(num: unknown, den: unknown): boolean {
  return typeof num === "number" && typeof den === "number" && Number.isSafeInteger(num) && Number.isSafeInteger(den) &&
    den > 0 && num >= den && BigInt(num) <= 240n * BigInt(den);
}

export function equalRate(a: Rate, b: Rate): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

function validLimits(schema: Record<string, unknown>): boolean {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    if (!Object.hasOwn(schema, key)) continue;
    const value = schema[key];
    if (typeof value !== "number" || !Number.isFinite(value) || (key === "multipleOf" && value <= 0)) return false;
  }
  return !Object.hasOwn(schema, "enum") || Array.isArray(schema["enum"]);
}

function allowsNumber(value: number, schema: Record<string, unknown>): boolean {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, enum: choices, const: fixed, multipleOf } = schema;
  return (typeof minimum !== "number" || value >= minimum) && (typeof maximum !== "number" || value <= maximum) &&
    (typeof exclusiveMinimum !== "number" || value > exclusiveMinimum) && (typeof exclusiveMaximum !== "number" || value < exclusiveMaximum) &&
    (!Array.isArray(choices) || choices.includes(value)) && (fixed === undefined || fixed === value) &&
    (typeof multipleOf !== "number" || Math.abs(value / multipleOf - Math.round(value / multipleOf)) <= Number.EPSILON * Math.max(1, Math.abs(value / multipleOf)));
}

/** Intersect the actual producer constraints with Studio's persisted shot format. */
export function samplingControl(binding: StudioGenerationBinding | undefined, field: (typeof OPTIONAL)[number]) {
  const params = [...(binding?.byStep.values() ?? [])].flat().filter(item => item.field === field);
  const integer = field === "steps" || params.some(p => p.integer);
  let min = field === "steps" ? 1 : 0.01;
  let max = field === "steps" ? 200 : 100;
  for (const { schema } of params) {
    if (typeof schema["minimum"] === "number") min = Math.max(min, schema["minimum"]);
    if (typeof schema["maximum"] === "number") max = Math.min(max, schema["maximum"]);
    if (typeof schema["const"] === "number") {
      min = Math.max(min, schema["const"]);
      max = Math.min(max, schema["const"]);
    }
  }
  const available = !binding || params.length > 0;
  const accepts = (v: number) => available && v >= min && v <= max && (!integer || Number.isInteger(v)) && params.every(p => allowsNumber(v, p.schema));
  return { available, min, max, integer, accepts };
}

export function frameLimits(routes: readonly (StudioRoute | null)[]) {
  // H3 limits only for routes whose steps are H3 (TE or DiT); declared producers bring their own schema limits below
  const h3 = routes.some((route) => route?.steps.some(({ providerId }) => isH3Provider(providerId) && (providerId === "h3.conditioning" || providerId === "h3.dit")) === true);
  let min = h3 ? H3_RULES.minFrames : 1;
  let max = h3 ? H3_RULES.maxFrames : 100000;
  const schemas = routes.flatMap((route) => [...(route?.generationBinding?.byStep.values() ?? [])].flat().filter(({ field }) => field === "frames").map(({ schema }) => schema));
  for (const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } of schemas) {
    if (typeof minimum === "number") min = Math.max(min, Math.ceil(minimum));
    if (typeof maximum === "number") max = Math.min(max, Math.floor(maximum));
    if (typeof exclusiveMinimum === "number") min = Math.max(min, Math.floor(exclusiveMinimum) + 1);
    if (typeof exclusiveMaximum === "number") max = Math.min(max, Math.ceil(exclusiveMaximum) - 1);
  }
  return { min, max, h3, allows: (value: number) => Number.isSafeInteger(value) && value >= min && value <= max && schemas.every((schema) => allowsNumber(value, schema)) };
}

export function attestsClock(binding: StudioGenerationBinding | undefined): boolean {
  return !!binding && (binding.fixedFps !== null || [...binding.byStep.values()].some((controls) => controls.some(({ field }) => field === "fps_num")));
}

export function clockProblem(binding: StudioGenerationBinding | undefined, rate: Rate): string | null {
  if (!validClock(rate.num, rate.den)) return t("影格率須介於 1 與 240 fps 之間");
  if (binding && BigInt(rate.num) > BigInt(binding.maxFps) * BigInt(rate.den)) return t("專案影格率超出元件宣告的參數範圍");
  if (binding && [...binding.byStep.values()].some((params) => params.some(({ field }) => field === "fps_num"))) {
    return [...binding.byStep.values()].every((params) => params.every(({ field, schema }) => (
      field === "fps_num" ? allowsNumber(rate.num, schema) : field !== "fps_den" || allowsNumber(rate.den, schema)
    ))) ? null : t("專案影格率超出元件宣告的參數範圍");
  }
  const native = binding?.fixedFps ?? { num: H3_RULES.fps, den: 1 };
  return equalRate(native, rate) ? null : t("這條路由需要 {num}/{den} fps 的專案", native);
}

export function bindingProblem(binding: StudioGenerationBinding, values: GenerationValues): string | null {
  const clock = clockProblem(binding, { num: Number(values.fps_num), den: Number(values.fps_den) });
  if (clock !== null) return clock;
  const bound = new Set<Field>();
  for (const fields of binding.byStep.values()) {
    for (const { field, integer, schema } of fields) {
      const value = values[field];
      if (value !== null && (!Number.isFinite(value) || (integer && !Number.isInteger(value)))) {
        return t("Studio 生成參數 {field} 的數值與元件型別不符", { field });
      }
      if (value !== null && !allowsNumber(value, schema)) return field === "frames" ? t("影格數超出元件宣告的參數範圍") : t("Studio 生成參數 {field} 的數值與元件型別不符", { field });
      bound.add(field);
    }
  }
  const missing = OPTIONAL.filter((field) => values[field] !== null && !bound.has(field));
  return missing.length ? t("這條元件組合未宣告鏡頭設定的覆寫參數：{fields}", { fields: missing.join(", ") }) : null;
}

export function boundParameters(binding: StudioGenerationBinding, step: string, base: Record<string, unknown>, values: GenerationValues): Record<string, unknown> {
  const overrides = (binding.byStep.get(step) ?? []).flatMap(({ field, name }) => {
    const value = values[field];
    return value === null ? [] : [[name, value] as const];
  });
  return { ...base, ...Object.fromEntries(overrides) };
}
