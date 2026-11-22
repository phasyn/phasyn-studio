import { downstreamOf } from "@/api/pipelineGraph";
// Image Studio 的運算路由＝使用者保存的元件組合（pipeline）中含 Qwen-Image DiT（qimg.dit）的那些。由 GET /api/pipelines
// 與元件目錄推導：每個步驟的角色（依 provider）、文生圖或圖生圖（有沒有接到前處理的參考圖輸入）、DiT 的精度（BF16／GGUF）、
// 哪些步驟所有圖片共用（前處理、文字條件、參考編碼）、哪些每張圖各一份（DiT 與它下游：解碼、合成），以及就緒狀態。
//
// 輸入的對應（範例元件組合 t2i-local／i2i-local；名稱不同時只要改這裡）：
// - prompt：接到文字條件步驟 `prompt` 埠的 text.prompt.v1 輸入；負面提示詞：接到 `negative_prompt` 埠的輸入。
// - 參考圖：接到前處理步驟 `references` 埠的 inline 輸入（qimg.references.v1＝[{file, label?}]，順序＝送出順序）。
// - 遮罩：接到前處理步驟 `mask` 埠的輸入（media.image.v1 檔案）。
// DiT 的精度＝load.provider_options.variant（bf16／gguf_q4km），放置＝load.offload.mode（phase／group_stream／none／
// gguf_phase），LoRA／slider＝provider_options.adapters（只有 bf16 可用）。
// 純函式；不送出任何請求，找不到元件就說找不到，不猜狀態。
import type { Catalog, ComponentDescriptor } from "@/api/generated/contracts";
import type { WirePipeline, WireStep } from "@/api/types";
import { isRecord } from "@/lib/json";
import { indexCatalog, type CatalogIndex } from "@/api/catalog";
import { componentSlot, type ComponentSlot } from "@/features/studio";
import { namesExperiment } from "@/lib/experimental";
import type { ImageMode } from "../types";
import { IMAGE_ASSET_TYPE, LIMITS, OUTPUT_IMAGE, OUTPUT_WHITE, PROMPT_TYPE, ROLE_BY_PROVIDER, ROLE_LABELS, variantLabel, type ImageStepRole } from "./constants";
import { t } from "@/i18n";
import { declaredImage, type DeclaredImage } from "./declaredImage";

export interface ImageRouteStep {
  step: WireStep;
  /** 由目錄查到的 provider；元件不在目錄時為 null。 */
  providerId: string | null;
  role: ImageStepRole | null;
  /** 訊息用的短名稱（前處理、DiT…；不認得的 provider 用 step_id）。 */
  name: string;
  slot: ComponentSlot;
}

export interface RouteOutput {
  /** 元件組合的輸出名稱。 */
  name: string;
  from_step: string;
  output: string;
}

export interface ImageRoute {
  declared?: DeclaredImage;
  /** pipeline_id（StudioImageShot.route 存的就是它）。 */
  id: string;
  label: string;
  pipeline: WirePipeline;
  steps: ImageRouteStep[];
  capability: ImageMode;
  /** 實驗或研究用的路由（名稱或任一步驟的元件寫明 research／實驗）：排在最後，也不會被選為新圖片的預設。 */
  experimental: boolean;
  /** DiT 元件的精度設定（provider_options.variant：bf16／gguf_q4km）；元件不在目錄或沒寫時 null。 */
  variant: string | null;
  /** DiT 元件的權重放置（load.offload.mode：phase／group_stream／none／gguf_phase）；未知時 null。 */
  placement: string | null;
  /** DiT 元件掛的 LoRA／slider（provider_options.adapters；GGUF 不接受）。 */
  adapters: { name: string; scale: number; kind: string | null }[];
  /** DiT 元件是否載入預覽用的 CPU VAE（provider_options.preview_vae）；沒寫＝false（runtime 預設），沒有 DiT 元件＝null。 */
  previewVae: boolean | null;
  promptInput: string;
  negativeInput: string | null;
  /** 參考圖清單的 inline 輸入（qimg.references.v1）；沒有時 null。 */
  referenceListInput: string | null;
  /** 最多可以送幾張參考圖（有清單輸入時是清單上限，沒有時 0＝只能文生圖）。 */
  referenceCapacity: number;
  maskInput: string | null;
  image: RouteOutput;
  white: RouteOutput | null;
  /** 所有圖片共用的範本步驟（只跑一次）。 */
  sharedStepIds: string[];
  /** 每張圖各一份的範本步驟（DiT 與它下游）。 */
  branchStepIds: string[];
  /** 角色 → 範本步驟 id（同一角色多個時取第一個）。 */
  roleSteps: Partial<Record<ImageStepRole, string>>;
  ditNodeId: string | null;
  ditComponent: ComponentDescriptor | null;
  ready: boolean;
  problems: string[];
  notes: string[];
  summary: string;
}

/** 元件的 load 設定中的一個物件欄位（已載入時看 loaded，否則看保存設定）。 */
function loadSection(component: ComponentDescriptor | null, key: "provider_options" | "offload"): Record<string, unknown> | null {
  if (!component) return null;
  const settings: unknown = component.settings;
  if (!isRecord(settings)) return null;
  const pick = (load: unknown) => (isRecord(load) && isRecord(load[key]) ? load[key] : null);
  const stored = isRecord(settings["stored"]) ? settings["stored"]["load"] : null;
  return pick(settings["loaded"]) ?? pick(stored);
}

function providerOptions(component: ComponentDescriptor | null): Record<string, unknown> | null {
  return loadSection(component, "provider_options");
}

/** DiT 的權重放置：load.offload.mode；沒有時 null。 */
export function componentPlacement(component: ComponentDescriptor | null): string | null {
  const mode = loadSection(component, "offload")?.["mode"];
  return typeof mode === "string" && mode ? mode : null;
}

export function componentAdapters(component: ComponentDescriptor | null): { name: string; scale: number; kind: string | null }[] {
  const raw = providerOptions(component)?.["adapters"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) =>
    isRecord(item) && typeof item["name"] === "string" && typeof item["scale"] === "number" ? [{ name: item["name"], scale: item["scale"], kind: typeof item["kind"] === "string" ? item["kind"] : null }] : [],
  );
}

export function componentOption(component: ComponentDescriptor | null, key: string): unknown {
  return providerOptions(component)?.[key];
}

const stringOption = (component: ComponentDescriptor | null, key: string) => {
  const value = componentOption(component, key);
  return typeof value === "string" && value ? value : null;
};

/** 參數 schema 對某個參數的支援：true＝宣告了；false＝schema 有列出參數但沒有它且不收額外參數；null＝不知道。 */
export function parameterSupport(component: ComponentDescriptor | null, name: string): boolean | null {
  const schema: unknown = component?.settings.parameters_schema;
  if (!isRecord(schema) || !isRecord(schema["properties"])) return null;
  if (Object.hasOwn(schema["properties"], name)) return true;
  return schema["additionalProperties"] === false ? false : null;
}

function inputBinding(step: WireStep, port: string): string | null {
  const binding = step.inputs[port];
  return binding && "from_input" in binding ? binding.from_input : null;
}

function findOutput(pipeline: WirePipeline, steps: readonly ImageRouteStep[], white: boolean): RouteOutput | null {
  const wanted = white ? OUTPUT_WHITE : OUTPUT_IMAGE;
  const named = pipeline.outputs[wanted];
  if (named) return { name: wanted, from_step: named.from_step, output: named.output };
  // 名稱不同時：依步驟元件的輸出型別（image.asset.v1）找，名稱含 white 的是白底版
  for (const [name, ref] of Object.entries(pipeline.outputs)) {
    if (name.toLowerCase().includes("white") !== white) continue;
    const component = steps.find((item) => item.step.step_id === ref.from_step)?.slot.component;
    const type = component?.outputs.find((port) => port.name === ref.output)?.type_id;
    if (type === IMAGE_ASSET_TYPE) return { name, from_step: ref.from_step, output: ref.output };
  }
  return null;
}

function summarize(problems: readonly string[], componentCount: number): string {
  if (problems.length === 0) return t("就緒");
  if (problems.length === 1) return problems[0] ?? "";
  return componentCount === problems.length ? t("{problemsCount} 個元件未就緒", { problemsCount: problems.length }) : t("{problemsCount} 個問題", { problemsCount: problems.length });
}

/** 元件組合或它的任一個元件是實驗／研究用（看名稱與元件 id，與 Video Studio 的「實驗」分組相同的判斷）。 */
function experimentalRoute(pipeline: WirePipeline, steps: readonly ImageRouteStep[]): boolean {
  return namesExperiment(pipeline.label, pipeline.pipeline_id, ...steps.flatMap((item) => [item.step.component_id, item.slot.component?.label]));
}

/** 單一元件組合 → 圖片路由；不是 Qwen-Image 的元件組合時為 null。 */
export function deriveImageRoute(pipeline: WirePipeline, index: CatalogIndex): ImageRoute | null {
  const steps: ImageRouteStep[] = pipeline.steps.map((step) => {
    const component = index.component(step.node_id, step.component_id);
    const providerId = component?.provider_id ?? null;
    const role = (providerId != null && providerId !== "") ? (ROLE_BY_PROVIDER[providerId] ?? null) : null;
    const name = role ? ROLE_LABELS[role] : step.step_id;
    return { step, providerId, role, name, slot: componentSlot(index, step.node_id, step.component_id, name) };
  });
  const declared = declaredImage(pipeline, steps);
  if (declared) {
    const unavailable = steps.flatMap((item) => item.slot.usable ? [] : [item.slot.reason ?? t("{name} 無法使用", { name: item.name })]);
    const problems = [...unavailable, ...declared.problems];
    const branch = downstreamOf(pipeline, declared.seedStep);
    const root = steps.find((item) => item.step.step_id === declared.seedStep);
    return {
      id: pipeline.pipeline_id, label: pipeline.label.trim() || pipeline.pipeline_id, pipeline, steps, capability: declared.referenceInputs.length ? "i2i" : "t2i", experimental: experimentalRoute(pipeline, steps),
      declared, variant: null, placement: null, adapters: [], previewVae: null, promptInput: declared.prompt,
      negativeInput: declared.negative, referenceListInput: null, referenceCapacity: declared.referenceInputs.length, maskInput: null,
      image: declared.image ?? { name: "", from_step: "", output: "" }, white: declared.white,
      sharedStepIds: steps.filter(({ step }) => !branch.has(step.step_id)).map(({ step }) => step.step_id),
      branchStepIds: steps.filter(({ step }) => branch.has(step.step_id)).map(({ step }) => step.step_id),
      roleSteps: {}, ditNodeId: root?.step.node_id ?? null, ditComponent: null,
      ready: problems.length === 0, problems, summary: summarize(problems, unavailable.length),
      notes: [t("只會送出此路由宣告的圖片控制項，其餘沿用元件組合的設定")],
    };
  }
  const hasDit = steps.some((item) => item.role === "dit");
  const unknown = steps.some((item) => item.providerId === null);
  // 元件不在目錄（Node 離線、元件已刪除）時無法確認 provider：同時有 image 與 image_white 輸出就當成圖片元件組合列出（顯示找不到元件）
  if (!hasDit && !(unknown && pipeline.outputs[OUTPUT_IMAGE] && pipeline.outputs[OUTPUT_WHITE])) return null;

  const byRole = (role: ImageStepRole) => steps.find((item) => item.role === role);
  const dit = byRole("dit") ?? steps.find((item) => item.providerId === null && item.step.step_id === "dit");
  const te = byRole("te") ?? steps.find((item) => item.providerId === null && inputBinding(item.step, "prompt") !== null);
  const prepare = byRole("prepare") ?? steps.find((item) => item.providerId === null && "mask" in item.step.inputs);

  const promptInput = te ? inputBinding(te.step, "prompt") : null;
  if (!(promptInput != null && promptInput !== "") || !pipeline.inputs.some((port) => port.name === promptInput && port.type_id === PROMPT_TYPE)) return null;
  const negativeInput = te ? inputBinding(te.step, "negative_prompt") : null;
  const listBinding = prepare ? inputBinding(prepare.step, "references") : null;
  const listPort = (listBinding != null && listBinding !== "") ? pipeline.inputs.find((port) => port.name === listBinding) : undefined;
  const referenceListInput = listPort && listPort.transport !== "file" ? listPort.name : null;
  const referenceCapacity = (referenceListInput != null && referenceListInput !== "") ? LIMITS.references : 0;
  const maskInput = prepare ? inputBinding(prepare.step, "mask") : null;
  const capability: ImageMode = referenceCapacity > 0 ? "i2i" : "t2i";

  const problems: string[] = steps.flatMap((item) => (item.slot.usable ? [] : [item.slot.reason ?? t("{name} 無法使用", { name: item.name })]));
  const componentProblems = problems.length;
  const image = findOutput(pipeline, steps, false);
  const white = findOutput(pipeline, steps, true);
  const branch = dit ? downstreamOf(pipeline, dit.step.step_id) : new Set<string>();
  const known = !unknown;
  if (known && !te) problems.push(t("元件組合沒有文字條件步驟（qimg.conditioning）"));
  if (known && !dit) problems.push(t("元件組合沒有 DiT 步驟（qimg.dit）"));
  if (!image) problems.push(t("元件組合沒有圖片輸出（image，image.asset.v1）"));
  if (image && dit && !branch.has(image.from_step)) problems.push(t("圖片輸出 {name} 不在 DiT 之後：無法每張圖各自輸出", { name: image.name }));
  if (white && dit && !branch.has(white.from_step)) problems.push(t("白底輸出 {name} 不在 DiT 之後：無法每張圖各自輸出", { name: white.name }));

  const ditComponent = dit?.slot.component ?? null;
  const variant = stringOption(ditComponent, "variant");
  const placement = componentPlacement(ditComponent);
  const adapters = componentAdapters(ditComponent);
  const previewRaw = componentOption(ditComponent, "preview_vae");
  // qimg.dit 沒寫 preview_vae 時以 false 載入（runtime 預設）：沒寫＝沒有預覽 VAE；沒有 DiT 元件時才是未知
  const previewVae = typeof previewRaw === "boolean" ? previewRaw : ditComponent ? false : null;
  const notes: string[] = [];
  if (!white) notes.push(t("元件組合沒有白底輸出（image_white）：「用在影片鏡頭」需要白底版"));
  if (previewVae === false) notes.push(t("DiT 沒有載入預覽 VAE（preview_vae: false）：VAE 縮圖預覽不可用"));

  const roleSteps: Partial<Record<ImageStepRole, string>> = {};
  for (const item of steps) if (item.role && !(roleSteps[item.role] != null && roleSteps[item.role] !== "")) roleSteps[item.role] = item.step.step_id;
  if (dit && !(roleSteps.dit != null && roleSteps.dit !== "")) roleSteps.dit = dit.step.step_id;
  if (te && !(roleSteps.te != null && roleSteps.te !== "")) roleSteps.te = te.step.step_id;

  return {
    id: pipeline.pipeline_id,
    label: pipeline.label.trim() || pipeline.pipeline_id,
    pipeline,
    steps,
    capability,
    experimental: experimentalRoute(pipeline, steps),
    variant,
    placement,
    adapters,
    previewVae,
    promptInput,
    negativeInput,
    referenceListInput,
    referenceCapacity,
    maskInput,
    image: image ?? { name: OUTPUT_IMAGE, from_step: dit?.step.step_id ?? "", output: OUTPUT_IMAGE },
    white,
    sharedStepIds: pipeline.steps.filter((step) => !branch.has(step.step_id)).map((step) => step.step_id),
    branchStepIds: pipeline.steps.filter((step) => branch.has(step.step_id)).map((step) => step.step_id),
    roleSteps,
    ditNodeId: dit?.step.node_id ?? null,
    ditComponent,
    ready: problems.length === 0,
    problems,
    notes,
    summary: summarize(problems, componentProblems),
  };
}

/** 所有圖片路由，順序與 GET /api/pipelines 相同，實驗／研究用的路由排在最後。 */
export function deriveImageRoutes(pipelines: readonly WirePipeline[] | undefined, catalog: Catalog | undefined): ImageRoute[] {
  const index = indexCatalog(catalog);
  const routes = (pipelines ?? []).flatMap((pipeline) => {
    const route = deriveImageRoute(pipeline, index);
    return route ? [route] : [];
  });
  return routes.sort((a, b) => Number(a.experimental) - Number(b.experimental));
}

export function findImageRoute(routes: readonly ImageRoute[], id: string): ImageRoute | null {
  return routes.find((route) => route.id === id) ?? null;
}

/**
 * 新圖片的預設路由：同模式中第一個就緒的正式（非實驗）元件組合，沒有就緒的時用同模式的第一個正式元件組合（依使用者設定的
 * 順序；在「生成引擎」啟動元件後就能用，與 Video Studio 的預設相同）；只有實驗路由時才用實驗路由；這個模式沒有任何元件
 * 組合時 undefined（「基本」分頁提供範本）。
 */
export function pickImageRoute(routes: readonly ImageRoute[], mode: ImageMode): ImageRoute | undefined {
  const fitting = routes.filter((route) => supportsImageMode(route, mode));
  const main = fitting.filter((route) => !route.experimental);
  return main.find((route) => route.ready) ?? main[0] ?? fitting.find((route) => route.ready) ?? fitting[0];
}

/**
 * 切換文生圖／圖生圖時對應的元件組合：模式相符、而且用的是同一個 DiT 元件（同一個模型與精度）。剛好一個時回傳，
 * 否則 null（由使用者自己選，不替使用者換模型）。
 */
export function counterpartRoute(routes: readonly ImageRoute[], current: ImageRoute | null, mode: ImageMode): ImageRoute | null {
  if (!current || supportsImageMode(current, mode)) return null;
  const ditStep = (current.roleSteps.dit != null && current.roleSteps.dit !== "") ? current.pipeline.steps.find((step) => step.step_id === current.roleSteps.dit) : undefined;
  if (!ditStep) return null;
  const candidates = routes.filter((route) => {
    if (!supportsImageMode(route, mode)) return false;
    const other = (route.roleSteps.dit != null && route.roleSteps.dit !== "") ? route.pipeline.steps.find((step) => step.step_id === route.roleSteps.dit) : undefined;
    return other?.node_id === ditStep.node_id && other.component_id === ditStep.component_id;
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function supportsImageMode(route: ImageRoute, mode: ImageMode): boolean {
  return route.capability === mode || (mode === "t2i" && route.declared?.requiredReferences === 0);
}

/** 路由與圖片模式不符時的說明；相符時 null。 */
export function modeMismatch(route: ImageRoute, mode: ImageMode): string | null {
  if (supportsImageMode(route, mode)) return null;
  return mode === "i2i"
    ? t("元件組合「{label}」是文生圖（沒有參考圖輸入）：圖生圖需要 i2i 元件組合", { label: route.label })
    : t("元件組合「{label}」是圖生圖（需要參考圖）：文生圖請改選 t2i 元件組合", { label: route.label });
}

/**
 * Why a shot of this mode can never be generated with this route, judged as before generating (planImageRender): the
 * route has to be one of Image Studio's image pipelines and fit the mode. Readiness is not part of it, since stopped
 * components are started from the engine sheet before generating. Null when the route fits. For features that write
 * image shots (prompt studies' "Apply to Image Studio").
 */
export function shotRouteProblem(routes: readonly ImageRoute[], routeId: string, mode: ImageMode): string | null {
  const route = findImageRoute(routes, routeId);
  return route ? modeMismatch(route, mode) : t("路由不存在：請選擇元件組合（目前的值：{value}）", { value: routeId });
}

/** 路由的一行特徵：「t2i・BF16・phase・LoRA 2」。 */
export function routeFacts(route: ImageRoute): string {
  if (route.declared) return route.referenceCapacity && !route.declared.requiredReferences ? "t2i / i2i" : route.capability;
  return [route.capability, variantLabel(route.variant), route.placement, route.adapters.length > 0 ? `LoRA ${String(route.adapters.length)}` : null].filter(Boolean).join(t("・"));
}

/**
 * 不擋生成的提醒（依圖片模式）：以 phase 放置做圖生圖時顯存可能不足（尚未量測；建議 group_stream），
 * 不足時 DiT 會在呼叫時回 422 並附原因。
 */
export function routeModeNotes(route: ImageRoute, mode: ImageMode): string[] {
  const notes: string[] = [];
  if (mode === "i2i" && route.placement === "phase") notes.push(t("phase 放置做圖生圖時顯存可能不夠（尚未量測；建議改用 group_stream 元件組合）；不夠時 DiT 會回 422 並說明原因"));
  return notes;
}
