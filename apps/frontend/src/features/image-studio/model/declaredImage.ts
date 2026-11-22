// 將 provider 的 studio_image v1 宣告接到實際已儲存的 pipeline；不依元件或步驟名稱推測。
import type { ComponentDescriptor, Port } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { t } from "@/i18n";
import { isRecord, stableStringify, valuesEqual } from "@/lib/json";
import type { StudioImageShot, StudioImageTake } from "../types";
import { DEFAULTS, IMAGE_ASSET_TYPE, PROMPT_TYPE } from "./constants";
import { validateValue } from "@/lib/schema/validate";
import { changedSinceTake, snapshotDiff, takeSnapshot, type ImageParamsSnapshot } from "./params";
import type { ImageRoute, ImageRouteStep, RouteOutput } from "./routes";

const controls = ["width", "height", "seed", "steps", "guidance", "sigma_schedule", "flow_shift_mu", "decode", "preview"] as const;
export type ImageControl = typeof controls[number];

export interface DeclaredImage {
  parameters: Map<string, Map<ImageControl, string>>;
  prompt: string;
  negative: string | null;
  referenceInputs: string[];
  requiredReferences: number;
  defaults: Partial<Record<"width" | "height" | "steps" | "guidance", number>>;
  fixed: Partial<Record<"width" | "height" | "steps" | "guidance", number>>;
  image: RouteOutput | null;
  white: RouteOutput | null;
  seedStep: string;
  problems: string[];
}

const inline = (p: Port, type: string): boolean => p.type_id === type && (p.transport === "inline" || p.transport === "either");
const semantic = (name: string): name is ImageControl => controls.some((key) => key === name);

function nativeParameters(component: ComponentDescriptor): Record<string, unknown> {
  const schema: unknown = component.settings.parameters_schema;
  return isRecord(schema) && isRecord(schema["properties"]) ? schema["properties"] : {};
}

function inspectStep(result: DeclaredImage, item: ImageRouteStep, pipeline: WirePipeline): boolean {
  const { step } = item;
  const component = item.slot.component;
  const declaration = component?.facts?.["studio_image"];
  if (!component || !isRecord(declaration) || declaration["version"] !== 1 ||
    Object.keys(declaration).some((key) => !["version", "parameters", "inputs", "outputs"].includes(key))) return false;
  const native = nativeParameters(component);
  const mapped = new Map<ImageControl, string>();
  for (const section of ["parameters", "inputs", "outputs"] as const) {
    if (!Object.hasOwn(declaration, section)) continue;
    const bindings = declaration[section];
    if (!isRecord(bindings) || new Set(Object.values(bindings)).size !== Object.keys(bindings).length) return false;
    for (const [key, port] of Object.entries(bindings)) {
      if (typeof port !== "string" || port === "" || ["__proto__", "constructor", "prototype"].includes(port)) return false;
      if (section === "parameters") {
        if (!semantic(key) || !Object.hasOwn(native, port)) return false;
        mapped.set(key, port);
        const spec = native[port];
        if (isRecord(spec) && (key === "width" || key === "height" || key === "steps" || key === "guidance")) {
          const options = spec["enum"];
          const fixed: unknown = spec["const"] ?? (Array.isArray(options) && options.length === 1 ? options[0] : undefined);
          const value: unknown = step.parameters[port] ?? component.settings.stored.invoke[port] ?? spec["default"] ?? fixed;
          if (typeof fixed === "number") result.fixed[key] = fixed;
          if (typeof value === "number") result.defaults[key] = value;
        }
        if (key === "seed") {
          if (result.seedStep !== "") return false;
          result.seedStep = step.step_id;
        }
      } else if (section === "inputs") {
        const ref = /^reference_([1-4])$/u.exec(key);
        if (ref) {
          const index = Number(ref[1]) - 1;
          const input = component.inputs.find((p) => p.name === port && p.type_id === "media.image.v1" && p.transport !== "inline");
          const link = step.inputs[port];
          if (!input) return false;
          if (!link && !input.required) continue;
          if (!link || !("from_input" in link)) return false;
          const external = pipeline.inputs.find((p) => p.name === link.from_input && p.type_id === "media.image.v1" && p.transport !== "inline");
          if (!external || (input.required && !external.required)) return false;
          if (result.referenceInputs[index] !== undefined && result.referenceInputs[index] !== external.name) return false;
          result.referenceInputs[index] = external.name;
          if (external.required) result.requiredReferences = Math.max(result.requiredReferences, index + 1);
          continue;
        }
        if (key !== "prompt" && key !== "negative_prompt") return false;
        const binding = step.inputs[port];
        if (!binding || !("from_input" in binding) || !component.inputs.some((p) => p.name === port && inline(p, PROMPT_TYPE)) ||
            !pipeline.inputs.some((p) => p.name === binding.from_input && inline(p, PROMPT_TYPE))) return false;
        const target = key === "prompt" ? "prompt" : "negative";
        if (result[target] !== null && result[target] !== "" && result[target] !== binding.from_input) return false;
        result[target] = binding.from_input;
      } else {
        if (key !== "image" && key !== "image_white") return false;
        const names = Object.entries(pipeline.outputs).filter(([, ref]) => ref.from_step === step.step_id && ref.output === port);
        const output = names[0];
        const target = key === "image" ? "image" : "white";
        if (result[target] !== null || !output || names.length !== 1 || !component.outputs.some((p) => p.name === port && inline(p, IMAGE_ASSET_TYPE))) return false;
        result[target] = { name: output[0], from_step: step.step_id, output: port };
      }
    }
  }
  result.parameters.set(step.step_id, mapped);
  return true;
}

function ancestors(steps: readonly ImageRouteStep[], final: string): Set<string> {
  const byId = new Map(steps.map(({ step }) => [step.step_id, step]));
  const seen = new Set<string>();
  const pending = [final];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const binding of Object.values(byId.get(id)?.inputs ?? {})) if ("from_step" in binding) pending.push(binding.from_step);
  }
  return seen;
}

export function declaredImage(pipeline: WirePipeline, steps: readonly ImageRouteStep[]): DeclaredImage | undefined {
  const declared = steps.filter(({ slot }) => Object.hasOwn(slot.component?.facts ?? {}, "studio_image"));
  if (declared.length === 0) return undefined;
  const result: DeclaredImage = { parameters: new Map(), prompt: "", negative: null, referenceInputs: [], requiredReferences: 0, defaults: {}, fixed: {}, image: null, white: null, seedStep: "", problems: [] };
  for (const item of declared) {
    if (!inspectStep(result, item, pipeline)) result.problems.push(t("步驟 {step} 的 studio_image 宣告與實際接線或參數不符", { step: item.step.step_id }));
  }
  const ports = Array.from(result.referenceInputs);
  if (ports.some((name) => !name) || new Set(ports).size !== ports.length) {
    result.problems.push(t("參考圖插槽必須從 1 連續接線，且每個插槽使用不同輸入。"));
  }
  const mapped = new Set([...result.parameters.values()].flatMap((values) => [...values.keys()]));
  if (!result.prompt || result.prompt === result.negative || !result.image || !result.seedStep || !mapped.has("width") || !mapped.has("height")) {
    result.problems.push(t("圖片路由必須宣告並接上 prompt、width、height、seed 與 image.asset.v1 輸出"));
  }
  if (result.image) {
    const path = ancestors(steps, result.image.from_step);
    const extra = result.white ? ancestors(steps, result.white.from_step) : new Set<string>();
    const disconnected = declared.some(({ step, slot }) => {
      if (path.has(step.step_id)) return false;
      const spec = slot.component?.facts?.["studio_image"];
      return step.step_id !== result.white?.from_step || !isRecord(spec) ||
        (isRecord(spec["inputs"]) && Object.keys(spec["inputs"]).length > 0) ||
        (result.parameters.get(step.step_id)?.size ?? 0) > 0;
    });
    if (!path.has(result.seedStep) || disconnected) {
      result.problems.push(t("圖片的宣告步驟必須接到成品，且每個成品輸出都須來自同一個 seed 步驟"));
    }
    if (result.white && !extra.has(result.seedStep)) result.problems.push(t("白底成品未接到圖片的 seed 步驟"));
  }
  return result;
}

export function unsupportedImageControl(decl: DeclaredImage, shot: StudioImageShot): string | null {
  const mapped = imageControls(decl);
  const modified: [ImageControl, boolean][] = [
    ["steps", shot.steps !== DEFAULTS.steps], ["guidance", shot.guidance !== DEFAULTS.guidance],
    ["sigma_schedule", shot.sigma_schedule !== DEFAULTS.sigma], ["flow_shift_mu", shot.flow_shift_mu !== null],
    ["decode", shot.decode !== DEFAULTS.decode],
    ["preview", shot.preview.mode !== "off" && (shot.preview.mode !== DEFAULTS.preview.mode || shot.preview.every !== DEFAULTS.preview.every)],
  ];
  if (shot.negative_prompt !== "" && decl.negative === null) return "negative_prompt";
  return modified.find(([key, changed]) => changed && !mapped.has(key))?.[0] ?? null;
}

export function declaredParams(decl: DeclaredImage, step: string, shot: StudioImageShot, seed: number): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, native] of decl.parameters.get(step) ?? []) {
    const value = key === "seed" ? seed : shot[key];
    if (value !== null) values[native] = value;
  }
  return values;
}

export function imageAlignment(route: ImageRoute | null, key: "width" | "height"): number {
  if (!route?.declared) return 32;
  let alignment = 1;
  for (const { step, slot } of route.steps) {
    const alias = route.declared.parameters.get(step.step_id)?.get(key);
    const field = alias !== undefined && slot.component ? nativeParameters(slot.component)[alias] : undefined;
    const multiple = isRecord(field) ? field["multipleOf"] : undefined;
    if (typeof multiple === "number" && Number.isSafeInteger(multiple) && multiple > 0) {
      let a = alignment, b = multiple;
      while (b) [a, b] = [b, a % b];
      alignment = alignment / a * multiple;
    }
  }
  return alignment;
}

export function imageControls(decl: DeclaredImage): Set<ImageControl> {
  return new Set([...decl.parameters.values()].flatMap((fields) => [...fields.keys()]));
}

export function supportsImageValue(route: ImageRoute, key: ImageControl, value: unknown): boolean {
  return route.steps.every(({ step, slot }) => {
    const native = route.declared?.parameters.get(step.step_id)?.get(key);
    const schema = slot.component?.settings.parameters_schema;
    if (native === undefined || !isRecord(schema) || !isRecord(schema["properties"])) return true;
    return validateValue(schema["properties"][native], value, schema).length === 0;
  });
}

export function declaredSnapshot(decl: DeclaredImage, shot: StudioImageShot, seed: number) {
  return {
    version: 1,
    controls: [...imageControls(decl)].sort(),
    parameters: Object.fromEntries([...decl.parameters.keys()].map((id) => [id, declaredParams(decl, id, shot, seed)])),
  };
}

export function storedImageDeclaration(raw: Record<string, unknown>) {
  const value = raw["studio_image"];
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["controls"]) || !isRecord(value["parameters"])) return null;
  return { controls: value["controls"].filter((key): key is string => typeof key === "string"), parameters: value["parameters"] };
}

export function changedImageSettings(take: StudioImageTake, shot: StudioImageShot): string[] {
  const changes = changedSinceTake(take, shot);
  const declaration = storedImageDeclaration(take.params_snapshot);
  if (!declaration) return changes;
  const snap = takeSnapshot(take);
  if (snap && snap.negative_prompt !== shot.negative_prompt && !changes.includes(t("負面提示詞"))) changes.push(t("負面提示詞"));
  return changes;
}

export function imageSnapshotDiff(a: StudioImageTake, b: StudioImageTake, left: ImageParamsSnapshot, right: ImageParamsSnapshot): [string, string, string][] {
  const da = storedImageDeclaration(a.params_snapshot);
  const db = storedImageDeclaration(b.params_snapshot);
  const rows = snapshotDiff(left, right);
  if (!da && !db) return rows;
  const common = new Set(["seed", t("尺寸"), t("模式"), t("運算路由"), "prompt", t("負面提示詞")]);
  const result = rows.filter(([label]) => common.has(label));
  for (const id of new Set([...Object.keys(da?.parameters ?? {}), ...Object.keys(db?.parameters ?? {})])) {
    const l = da?.parameters[id];
    const r = db?.parameters[id];
    const first = isRecord(l) ? l : {};
    const second = isRecord(r) ? r : {};
    for (const key of new Set([...Object.keys(first), ...Object.keys(second)])) {
      if (!valuesEqual(first[key], second[key])) result.push([
        id + "." + key,
        first[key] === undefined ? "—" : stableStringify(first[key]),
        second[key] === undefined ? "—" : stableStringify(second[key]),
      ]);
    }
  }
  return result;
}

export function clearImageControl(control: string): Partial<StudioImageShot> {
  switch (control) {
    case "negative_prompt": return { negative_prompt: "" };
    case "steps": return { steps: DEFAULTS.steps };
    case "guidance": return { guidance: DEFAULTS.guidance };
    case "sigma_schedule": return { sigma_schedule: DEFAULTS.sigma };
    case "flow_shift_mu": return { flow_shift_mu: null };
    case "decode": return { decode: DEFAULTS.decode };
    case "preview": return { preview: { ...DEFAULTS.preview, mode: "off" } };
    default: return {};
  }
}
