// 生成用的元件組合（t2i 圖片 pipeline）與「生成一張圖」的 run（純函式）。
// 只認得這些 provider：qimg.conditioning（TE）→ qimg.dit → qimg.vae_decode → image.compose；
// 有 qimg.prepare／qimg.vae_encode（圖生圖）或需要圖片輸入的元件組合不能用（反推的生成只用文字，原圖不當參考）。
// 參數覆寫：TE 的 cfg（guidance>1 才編碼負面提示詞）、DiT 的尺寸／步數／guidance／sigma／μ／seed／預覽、VAE 的解碼模式；
// 其餘沿用元件組合範本。每個步驟的參數先用元件宣告的 parameters_schema 檢查，不符就不送出（不假裝套用）。
import type { Catalog, Port } from "@/api/generated/contracts";
import type { RunRequestBody, WirePipeline, WireStep, WireTypedValue } from "@/api/types";
import { indexCatalog } from "@/api/catalog";
import { componentSlot, type ComponentSlot } from "@/features/studio";
import { cloneJson, isRecord } from "@/lib/json";
import { validateValue } from "@/lib/schema";
import type { GenerationSettings } from "../types";
import type { StepErrorText } from "./stepError";
import { t } from "@/i18n";

export const PROVIDERS = {
  te: "qimg.conditioning",
  dit: "qimg.dit",
  vae: "qimg.vae_decode",
  compose: "image.compose",
  prepare: "qimg.prepare",
  venc: "qimg.vae_encode",
  vision: "qimg.vision",
  compile: "prompt.scene_compile",
  score: "prompt.scene_score",
} as const;

export const PROMPT_TYPE = "text.prompt.v1";
export const IMAGE_ASSET_TYPE = "image.asset.v1";

const SHORT_NAMES: Record<string, string> = {
  [PROVIDERS.te]: "TE",
  [PROVIDERS.dit]: "DiT",
  [PROVIDERS.vae]: t("VAE 解碼"),
  [PROVIDERS.compose]: t("合成"),
  [PROVIDERS.prepare]: t("前處理"),
  [PROVIDERS.venc]: t("VAE 編碼"),
};

export interface ImageRouteStep {
  step: WireStep;
  providerId: string | null;
  name: string;
  slot: ComponentSlot;
}

export interface ImageRoute {
  id: string;
  label: string;
  pipeline: WirePipeline;
  steps: ImageRouteStep[];
  /** prompt 的元件組合輸入。 */
  promptInput: string | null;
  /** 負面提示詞的元件組合輸入（沒有時 guidance>1 也不能帶負面提示詞）。 */
  negativeInput: string | null;
  /** 白底版（RGB）的元件組合輸出名稱。 */
  whiteOutput: string | null;
  /** 透明版（RGBA）的元件組合輸出名稱。 */
  rgbaOutput: string | null;
  ditComponentId: string | null;
  ready: boolean;
  /** 不能用的原因（結構或元件未就緒）。 */
  problems: string[];
}

function bindsInput(step: WireStep, input: string): boolean {
  return Object.values(step.inputs).some((binding) => "from_input" in binding && binding.from_input === input);
}

/** 單一元件組合 → 反推用的生成路由；不是 qimg 圖片元件組合時為 null。 */
export function deriveImageRoute(pipeline: WirePipeline, catalog: Catalog | undefined): ImageRoute | null {
  const index = indexCatalog(catalog);
  const steps: ImageRouteStep[] = pipeline.steps.map((step) => {
    const component = index.component(step.node_id, step.component_id);
    const providerId = component?.provider_id ?? null;
    const name = ((providerId != null && providerId !== "") ? SHORT_NAMES[providerId] : undefined) ?? step.step_id;
    return { step, providerId, name, slot: componentSlot(index, step.node_id, step.component_id, name) };
  });
  const dit = steps.find((item) => item.providerId === PROVIDERS.dit);
  // 元件不在目錄時看不出 provider：只有 step_id 叫 dit 的才當成可能的圖片元件組合，顯示為找不到元件
  if (!dit && !steps.some((item) => item.providerId === null && /dit/i.test(item.step.step_id))) return null;
  if (steps.some((item) => item.providerId?.startsWith("h3.") === true)) return null;

  const problems: string[] = [];
  if (steps.some((item) => item.providerId === PROVIDERS.prepare || item.providerId === PROVIDERS.venc)) problems.push(t("這是圖生圖元件組合（有前處理／VAE 編碼）：反推的生成只用文字"));
  const te = steps.find((item) => item.providerId === PROVIDERS.te);
  const texts = pipeline.inputs.filter((port) => port.type_id === PROMPT_TYPE);
  // TE 的 prompt／negative_prompt 埠直接接到哪個元件組合輸入（qimg.conditioning 的埠名）
  const fedBy = (port: string): string | null => {
    const binding = te?.step.inputs[port];
    return binding && "from_input" in binding ? binding.from_input : null;
  };
  const tePrompt = fedBy("prompt");
  const teNegative = fedBy("negative_prompt");
  const promptInput =
    texts.find((port) => port.name === "prompt")?.name ??
    texts.find((port) => port.name === tePrompt)?.name ??
    texts.find((port) => !/negative/i.test(port.name))?.name ??
    null;
  const negativeInput =
    pipeline.inputs.find((port) => port.name !== promptInput && port.name === teNegative)?.name ??
    pipeline.inputs.find((port) => port.name !== promptInput && /negative/i.test(port.name) && te !== undefined && bindsInput(te.step, port.name))?.name ??
    pipeline.inputs.find((port) => port.name !== promptInput && /negative/i.test(port.name))?.name ??
    null;
  if (!(promptInput != null && promptInput !== "")) problems.push(t("元件組合沒有 prompt 輸入（text.prompt.v1）"));
  for (const port of pipeline.inputs) {
    if (port.required && port.name !== promptInput && port.name !== negativeInput) problems.push(t("必填輸入「{name}」（{type_id}）本頁無法提供", { name: port.name, type_id: port.type_id }));
  }
  const outputs = Object.entries(pipeline.outputs);
  const whiteOutput = outputs.find(([name]) => name === "image_white")?.[0] ?? outputs.find(([, ref]) => ref.output === "image_white")?.[0] ?? null;
  const rgbaOutput = outputs.find(([name]) => name === "image")?.[0] ?? outputs.find(([, ref]) => ref.output === "image")?.[0] ?? null;
  if (!(whiteOutput != null && whiteOutput !== "") && !(rgbaOutput != null && rgbaOutput !== "")) problems.push(t("元件組合沒有 image／image_white 輸出"));
  if (!dit) problems.push(t("找不到 qimg.dit 步驟的元件"));
  for (const item of steps) if (!item.slot.usable && (item.slot.reason != null && item.slot.reason !== "")) problems.push(item.slot.reason);
  return {
    id: pipeline.pipeline_id,
    label: pipeline.label || pipeline.pipeline_id,
    pipeline,
    steps,
    promptInput,
    negativeInput,
    whiteOutput,
    rgbaOutput,
    ditComponentId: dit?.step.component_id ?? null,
    ready: problems.length === 0,
    problems,
  };
}

export function deriveImageRoutes(pipelines: readonly WirePipeline[] | undefined, catalog: Catalog | undefined): ImageRoute[] {
  return (pipelines ?? []).map((pipeline) => deriveImageRoute(pipeline, catalog)).filter((route): route is ImageRoute => route !== null);
}

// ---------------------------------------------------------------- 生成設定檢查

export function settingsProblems(settings: GenerationSettings): string[] {
  const problems: string[] = [];
  for (const [label, value] of [
    [t("寬度"), settings.width],
    [t("高度"), settings.height],
  ] as const) {
    if (!Number.isInteger(value) || value < 256 || value > 2048 || value % 32 !== 0) problems.push(t("{label}必須是 256–2048 之間 32 的倍數", { label }));
  }
  if (!Number.isInteger(settings.steps) || settings.steps < 2 || settings.steps > 100) problems.push(t("步數必須是 2–100 的整數"));
  if (!Number.isFinite(settings.guidance) || settings.guidance < 0 || settings.guidance > 20) problems.push(t("guidance 必須在 0–20"));
  if (settings.flow_shift_mu !== null && (!Number.isFinite(settings.flow_shift_mu) || settings.flow_shift_mu < -1 || settings.flow_shift_mu > 3)) problems.push(t("flow shift μ 必須在 −1–3，或留空（自動）"));
  if (settings.preview.mode !== "off" && (!Number.isInteger(settings.preview.every) || settings.preview.every < 1 || settings.preview.every > 100)) problems.push(t("預覽間隔必須是 1–100 步"));
  if (settings.negative_prompt.length > 12000) problems.push(t("負面提示詞超過 12,000 字"));
  return problems;
}

/** 依來源比例找一組 32 倍數的尺寸（qimg.dit 的對齊；面積約 1024²，邊長 256–2048）。 */
export function fitAspect(sourceWidth: number, sourceHeight: number, area = 1024 * 1024): { width: number; height: number } | null {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  const ratio = sourceWidth / sourceHeight;
  const clamp = (value: number) => Math.min(2048, Math.max(256, Math.round(value / 32) * 32));
  return { width: clamp(Math.sqrt(area * ratio)), height: clamp(Math.sqrt(area / ratio)) };
}

/** 來源與輸出的長寬比差距超過 1%：構圖與裁切的比較會受限（只提醒，不擋）。 */
export function aspectMismatch(sourceWidth: number | null, sourceHeight: number | null, settings: Pick<GenerationSettings, "width" | "height">): boolean {
  if (!(sourceWidth != null && Boolean(sourceWidth)) || !(sourceHeight != null && Boolean(sourceHeight))) return false;
  return Math.abs(sourceWidth / sourceHeight - settings.width / settings.height) > 0.01;
}

// ---------------------------------------------------------------- 生成一張圖的 run

function overrideParameters(providerId: string | null, base: Record<string, unknown>, settings: GenerationSettings, seed: number): Record<string, unknown> {
  const parameters = cloneJson(base);
  if (providerId === PROVIDERS.te) {
    parameters["cfg"] = settings.guidance > 1;
  } else if (providerId === PROVIDERS.dit) {
    parameters["width"] = settings.width;
    parameters["height"] = settings.height;
    parameters["steps"] = settings.steps;
    parameters["guidance"] = settings.guidance;
    parameters["sigma_schedule"] = settings.sigma_schedule;
    parameters["flow_shift_mu"] = settings.flow_shift_mu;
    parameters["seed"] = seed;
    parameters["preview"] = settings.preview.mode === "off" ? { mode: "off" } : { mode: settings.preview.mode, every: settings.preview.every };
  } else if (providerId === PROVIDERS.vae) {
    parameters["mode"] = settings.decode;
  }
  return parameters;
}

export type RenderRunPlan = { ok: true; body: RunRequestBody } | { ok: false; problem: StepErrorText };

/** 一張圖（一個候選 × 一個 seed）的 run；route 不能用、設定或參數不符時回傳原因。 */
export function planRenderRun(route: ImageRoute, input: { prompt: string; settings: GenerationSettings; seed: number; label: string }, catalog: Catalog | undefined): RenderRunPlan {
  // Problems are structured (worded when shown); the route and settings lines keep the words their checks used.
  if (!route.ready) return { ok: false, problem: { kind: "route_unusable", label: route.label, problems: route.problems } };
  const settingsIssues = settingsProblems(input.settings);
  if (settingsIssues.length > 0) return { ok: false, problem: { kind: "settings_invalid", problems: settingsIssues } };
  if (!input.prompt.trim()) return { ok: false, problem: { kind: "prompt_empty" } };
  if (!(route.promptInput != null && route.promptInput !== "")) return { ok: false, problem: { kind: "no_prompt_input" } };
  const negative = input.settings.guidance > 1 ? input.settings.negative_prompt.trim() : "";
  if (negative && !(route.negativeInput != null && route.negativeInput !== "")) return { ok: false, problem: { kind: "no_negative_input", label: route.label } };

  const index = indexCatalog(catalog);
  const steps: WireStep[] = [];
  for (const item of route.steps) {
    const parameters = overrideParameters(item.providerId, item.step.parameters, input.settings, input.seed);
    const component = index.component(item.step.node_id, item.step.component_id);
    const schema = component?.settings.parameters_schema;
    if (isRecord(schema) && Object.keys(schema).length > 0) {
      const issues = validateValue(schema, parameters, schema);
      if (issues.length > 0) {
        return { ok: false, problem: { kind: "params_rejected", component_id: item.step.component_id, name: item.name, issues: issues.map(({ path, message }) => ({ path, message })) } };
      }
    }
    steps.push({ ...cloneJson(item.step), parameters });
  }

  const ports: Port[] = [];
  const inputs: Record<string, WireTypedValue> = {};
  for (const port of route.pipeline.inputs) {
    if (port.name === route.promptInput) {
      ports.push(port);
      inputs[port.name] = { type_id: port.type_id, value: input.prompt };
    } else if (port.name === route.negativeInput) {
      ports.push(port);
      if (negative) inputs[port.name] = { type_id: port.type_id, value: negative };
    } else if (!port.required) {
      ports.push(port);
    }
  }
  return {
    ok: true,
    body: {
      pipeline: { pipeline_id: route.pipeline.pipeline_id, label: route.pipeline.label, inputs: ports, steps, outputs: cloneJson(route.pipeline.outputs) },
      inputs,
      label: input.label,
    },
  };
}
