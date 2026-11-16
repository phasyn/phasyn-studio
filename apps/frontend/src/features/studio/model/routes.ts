// Studio 的運算路由＝使用者在「元件修改・元件組合」保存的 pipeline。這裡由 GET /api/pipelines 與元件目錄推導：
// 哪些元件組合能給 Studio 用（剛好 1 個 text.prompt.v1 輸入、有 media.asset.v1 輸出）、能做哪種 H3 任務
// （t2va／fl2va／ref2va：看接線與 DiT 的 checkpoint），以及每個步驟元件是否就緒。
// 純函式；不送出任何請求，也不猜測沒有證據的狀態（找不到元件就說找不到）。
import { indexCatalog, type CatalogIndex } from "@/api/catalog";
import type { Catalog, ComponentDescriptor, StudioProject } from "@/api/generated/contracts";
import type { WirePipeline, WireStep } from "@/api/types";
import { placeLabel } from "@/lib/deviceTag";
import { acceptedSteps, describeConflicts, samplingConflicts } from "@/lib/ditSampling";
import { componentVariant, VARIANT_FL2VA, VARIANT_REF2VA } from "@/lib/h3Variant";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export const PROMPT_TYPE = "text.prompt.v1";
export const ASSET_TYPE = "media.asset.v1";
export const MATERIALS_TYPE = "h3.materials.v1";
export const IMAGE_TYPE = "media.image.v1";

/** Studio 認得並會覆寫參數或額外加入的 provider。 */
export const PROVIDER = {
  te: "h3.conditioning",
  dit: "h3.dit",
  reference: "h3.reference",
  frame: "media.frame",
  concat: "media.concat",
} as const;

export type RouteTask = "t2va" | "fl2va" | "ref2va";

/** H3 任務需要的 checkpoint variant（runtimes/h3 config.py TASK_VARIANT；DiT 與 reference encode 都會檢查）。 */
export const TASK_VARIANT: Record<RouteTask, string> = { t2va: VARIANT_FL2VA, fl2va: VARIANT_FL2VA, ref2va: VARIANT_REF2VA };

export const TASK_LABELS: Record<RouteTask, string> = {
  t2va: t("文字生成影音"),
  fl2va: t("首幀（接續前一個鏡頭或素材庫圖片）"),
  ref2va: t("參考素材"),
};

export const ROUTE_MISSING = t("路由不存在：請選擇元件組合");

/**
 * Placeholder route of a new project or image while no suitable pipeline is available (the contract requires a
 * non-empty id). It matches no pipeline, so the UI shows ROUTE_MISSING and asks the user to choose one.
 */
export const UNASSIGNED_ROUTE = "unassigned";

const STATE_LABELS: Record<string, string> = {
  stopped: t("已停止"),
  loading: t("載入中"),
  ready: t("就緒"),
  busy: t("呼叫中"),
  stopping: t("停止中"),
  error: t("錯誤"),
};

/** 訊息用的短名稱；不認得的 provider 用 step_id。 */
const SHORT_NAMES: Record<string, string> = {
  "h3.conditioning": "TE",
  "h3.dit": "DiT",
  "h3.video_decode": t("影片解碼"),
  "h3.audio_decode": t("音訊解碼"),
  "h3.reference": t("參考編碼"),
  "media.mux": t("封裝"),
  "media.frame": t("取影格"),
  "media.concat": t("序列匯出"),
};

// ---------------------------------------------------------------- 元件狀態（目錄索引在 @/api/catalog）

export interface ComponentSlot {
  nodeId: string;
  componentId: string;
  component: ComponentDescriptor | null;
  nodeLabel: string;
  /** 可以送出呼叫：ready 或 busy（busy 時同一 run 內由 runner 排隊，跨 run 由主控回 409）。 */
  usable: boolean;
  reason: string | null;
}

/** 一個步驟（或額外角色）所用元件的狀態與不能用的原因。name 是訊息裡的短名稱（TE、DiT、取影格…）。 */
export function componentSlot(index: CatalogIndex, nodeId: string, componentId: string, name: string): ComponentSlot {
  const component = index.component(nodeId, componentId);
  const node = index.nodeLabel(nodeId) ?? nodeId.slice(0, 8);
  // 顯示用「[GPU 0] Node A（GPU 0 + GPU 1）」：同一台 Node 上看得出元件用哪張卡；找不到元件時只有 Node 名稱
  const nodeLabel = component ? placeLabel(component.device, node) : node;
  const base = { nodeId, componentId, component, nodeLabel };
  if (!component) return { ...base, usable: false, reason: t("{name}：找不到元件 {componentId}（{node}）；請到「元件修改・元件」確認", { name, componentId, node }) };
  if (index.online(nodeId) === false) return { ...base, usable: false, reason: t("{name}所在的 {node} 不在線上", { name, node }) };
  const usable = component.state === "ready" || component.state === "busy";
  return { ...base, usable, reason: usable ? null : t("{name} {value}（{componentId}）", { name, value: STATE_LABELS[component.state] ?? component.state, componentId }) };
}

function preferUsable(items: readonly ComponentDescriptor[]): ComponentDescriptor | null {
  return items.find((item) => item.state === "ready") ?? items.find((item) => item.state === "busy") ?? items[0] ?? null;
}

// 元件實際用的 checkpoint variant 由共用的 lib 判斷（範本也依它挑 DiT）；這裡保留原本的匯出位置。
export { componentVariant };

// ---------------------------------------------------------------- 元件組合 → 路由

export interface RouteStep {
  step: WireStep;
  /** 由目錄查到的 provider；元件不在目錄時為 null。 */
  providerId: string | null;
  /** 訊息用的短名稱（TE、DiT…；不認得的 provider 用 step_id）。 */
  name: string;
  slot: ComponentSlot;
}

export interface StudioRoute {
  /** pipeline_id（StudioShot.route／StudioTake.route 存的就是它）。 */
  id: string;
  label: string;
  pipeline: WirePipeline;
  steps: RouteStep[];
  /** 唯一的 text.prompt.v1 輸入。 */
  promptInput: string;
  /** 成片（media.asset.v1）來自哪個步驟的哪個輸出；name 是元件組合的輸出名稱。 */
  final: { name: string; from_step: string; output: string };
  capability: RouteTask;
  /** 接到 TE materials 的 h3.materials.v1 輸入（ref2va）。 */
  materialsInput: string | null;
  /** 接到 TE first_frame 的 media.image.v1 輸入（fl2va）。 */
  imageInput: string | null;
  teStepId: string | null;
  ditStepId: string | null;
  teNodeId: string | null;
  ditNodeId: string | null;
  /** DiT 元件的 checkpoint variant；元件不在目錄時為 null。 */
  ditVariant: string | null;
  /**
   * 元件組合有參考素材輸入（h3.materials.v1 → TE 的 materials），但 DiT 不是 ref2va checkpoint，所以只能當
   * t2va／fl2va 用：說明這個原因；其他情況（包含 DiT 不在目錄、無法判斷）為 null。不擋渲染，只用在「不支援參考素材」的說明。
   */
  referenceHint: string | null;
  ready: boolean;
  problems: string[];
  /** 不擋渲染的提醒（例如原版 DiT 被元件組合固定成較少步數）。 */
  notes: string[];
  /** DiT 預設的去噪步數少於 FEW_STEPS 時的品質提醒（每個顯示或選擇路線的地方都要看得到）；其他情況為 null。 */
  caveat: RouteCaveat | null;
  /** 一行摘要；細節在 problems 與渲染引擎側欄。 */
  summary: string;
}

/** 少於這個去噪步數的 DiT 會加上品質提醒（步數少時快速運鏡與角色動作較弱）。 */
export const FEW_STEPS = 4;

export interface RouteCaveat {
  steps: number;
  /** 一句提醒，例如「DiT 3 步：快速運鏡（甩鏡、推鏡、衝擊）會變弱，角色動作可能變小」。 */
  text: string;
}

/**
 * DiT 這次預設會跑幾步：元件組合步驟參數優先，其次元件保存的 invoke 預設，再其次元件回報可接受的步數（LoRA 採樣合約，
 * 取最多的）；都沒有時為 null（元件內建預設，未回報）。
 */
function ditStepCount(step: WireStep, component: ComponentDescriptor): number | null {
  const value = readDitParameter(step, component, "steps").value;
  if (value !== null) return value;
  const accepted = acceptedSteps(component);
  return accepted ? Math.max(...accepted) : null;
}

function routeCaveat(step: WireStep, component: ComponentDescriptor, capability: RouteTask): RouteCaveat | null {
  const steps = ditStepCount(step, component);
  if (steps === null || steps >= FEW_STEPS) return null;
  // 參考素材（換角）路線上看到的現象；其他任務沒有這樣的觀察，只說步數
  const text = capability === "ref2va" ? t("DiT {steps} 步：快速運鏡（甩鏡、推鏡、衝擊）會變弱，角色動作可能變小", { steps }) : t("DiT 只跑 {steps} 步（少於 {min} 步，實驗設定）", { steps, min: FEW_STEPS });
  return { steps, text };
}

interface Issue {
  name: string;
  text: string;
  component: boolean;
}

function summarize(issues: readonly Issue[]): string {
  if (issues.length === 0) return t("就緒");
  if (issues.length === 1) return issues[0]?.text ?? "";
  const names = formatList([...new Set(issues.map((issue) => issue.name))]);
  return issues.every((issue) => issue.component) ? t("{issuesCount} 個元件未就緒（{names}）", { issuesCount: issues.length, names }) : t("{issuesCount} 個問題（{names}）", { issuesCount: issues.length, names });
}

function bindsInput(step: WireStep, input: string): boolean {
  return Object.values(step.inputs).some((binding) => "from_input" in binding && binding.from_input === input);
}

function consumes(step: WireStep, fromStep: string, output: string): boolean {
  return Object.values(step.inputs).some((binding) => "from_step" in binding && binding.from_step === fromStep && binding.output === output);
}

/** step 的 port 直接接到某個型別為 typeId 的元件組合輸入時，回傳輸入名稱。 */
function feedingInput(pipeline: WirePipeline, step: WireStep, port: string, typeId: string): string | null {
  const binding = step.inputs[port];
  if (!binding || !("from_input" in binding)) return null;
  return pipeline.inputs.some((item) => item.name === binding.from_input && item.type_id === typeId) ? binding.from_input : null;
}

function finalOutput(pipeline: WirePipeline, steps: readonly RouteStep[]): StudioRoute["final"] | null {
  const typed = Object.entries(pipeline.outputs).map(([name, ref]) => {
    const component = steps.find((item) => item.step.step_id === ref.from_step)?.slot.component ?? null;
    return { name, from_step: ref.from_step, output: ref.output, known: component !== null, type: component?.outputs.find((port) => port.name === ref.output)?.type_id ?? null };
  });
  const assets = typed.filter((item) => item.type === ASSET_TYPE);
  // 元件已不在目錄時無法確認型別：名為 final 的輸出仍列出（路由會顯示找不到元件），不讓已設定的元件組合默默消失
  const chosen = assets.find((item) => item.name === "final") ?? assets[0] ?? typed.find((item) => item.name === "final" && !item.known);
  return chosen ? { name: chosen.name, from_step: chosen.from_step, output: chosen.output } : null;
}

/** 單一元件組合 → Studio 路由；不符合 Studio 條件（prompt 輸入、成片輸出）時為 null。 */
export function deriveRoute(pipeline: WirePipeline, index: CatalogIndex): StudioRoute | null {
  const prompts = pipeline.inputs.filter((port) => port.type_id === PROMPT_TYPE);
  const prompt = prompts.length === 1 ? prompts[0] : undefined;
  if (!prompt) return null;
  const steps: RouteStep[] = pipeline.steps.map((step) => {
    const component = index.component(step.node_id, step.component_id);
    const providerId = component?.provider_id ?? null;
    const name = (providerId ? SHORT_NAMES[providerId] : undefined) ?? step.step_id;
    return { step, providerId, name, slot: componentSlot(index, step.node_id, step.component_id, name) };
  });
  const final = finalOutput(pipeline, steps);
  if (!final) return null;

  const te = steps.find((item) => item.providerId === PROVIDER.te) ?? steps.find((item) => item.providerId === null && bindsInput(item.step, prompt.name));
  const dit =
    steps.find((item) => item.providerId === PROVIDER.dit) ??
    (te ? steps.find((item) => item.providerId === null && consumes(item.step, te.step.step_id, "conditioning")) : undefined);
  const materialsInput = te ? feedingInput(pipeline, te.step, "materials", MATERIALS_TYPE) : null;
  const imageInput = te ? feedingInput(pipeline, te.step, "first_frame", IMAGE_TYPE) : null;
  const ditVariant = dit?.slot.component ? componentVariant(dit.slot.component) : null;
  // DiT 不在目錄（variant 未知）時只看接線；能否真的執行由就緒狀態說明
  const capability: RouteTask =
    materialsInput && (ditVariant ?? TASK_VARIANT.ref2va) === TASK_VARIANT.ref2va
      ? "ref2va"
      : imageInput && (ditVariant ?? TASK_VARIANT.fl2va) === TASK_VARIANT.fl2va
        ? "fl2va"
        : "t2va";
  // 接了參考素材輸入卻用了非 ref2va 的 DiT：路由只剩 t2va／fl2va。把原因說清楚（常見於範本預設選到 FL2VA 的 DiT），
  // 否則使用者只看到「不支援參考素材」而 DiT 其實已經啟動
  const referenceHint =
    materialsInput && dit && ditVariant !== null && ditVariant !== TASK_VARIANT.ref2va
      ? t("元件組合接了參考素材輸入，但它的 DiT（{id}）載入的是 {ditVariant} checkpoint；參考素材需要 ref2va checkpoint 的 DiT：把去噪步驟換成 ref2va 的 DiT", { id: dit.step.component_id, ditVariant })
      : null;

  const issues: Issue[] = steps.flatMap((item) => (item.slot.usable ? [] : [{ name: item.name, text: item.slot.reason ?? t("{name} 無法使用", { name: item.name }), component: true }]));
  // Studio 的時長、解析度與 seed 只能經由 H3 的 TE／DiT 步驟套用；沒有這些步驟就不假裝套用
  const known = steps.every((item) => item.providerId !== null);
  if (known && !te) issues.push({ name: t("結構"), text: t("元件組合沒有 H3 文字條件步驟（h3.conditioning）：Studio 的時長與解析度無法套用"), component: false });
  if (known && !dit) issues.push({ name: t("結構"), text: t("元件組合沒有 H3 DiT 步驟（h3.dit）：Studio 的 seed 與步數無法套用"), component: false });
  const wanted = TASK_VARIANT[capability];
  if (dit && ditVariant && ditVariant !== wanted) {
    const id = dit.step.component_id;
    issues.push({
      name: "DiT",
      text:
        ditVariant === TASK_VARIANT.ref2va && !materialsInput
          ? t("DiT（{id}）是 ref2va checkpoint，但元件組合沒有參考素材輸入（h3.materials.v1 → TE 的 materials）", { id })
          : t("DiT（{id}）載入的是 {ditVariant} checkpoint；{capability} 需要 {wanted}", { id, ditVariant, capability, wanted }),
      component: false,
    });
  }
  // 元件組合固定的步數／shift 與 DiT 不符：有 LoRA 採樣合約的會在 DiT 步驟被拒絕（前面的步驟白跑），先擋下；原版只提醒
  const notes: string[] = [];
  if (dit?.slot.component) {
    const conflicts = samplingConflicts(dit.step.parameters, dit.slot.component);
    const contract = conflicts.filter((item) => item.blocking);
    const soft = conflicts.filter((item) => !item.blocking);
    if (contract.length > 0) issues.push({ name: "DiT", text: describeConflicts(contract, dit.step.component_id, t("元件組合")), component: false });
    if (soft.length > 0) notes.push(describeConflicts(soft, dit.step.component_id, t("元件組合")));
  }
  for (const item of steps) {
    if (item.providerId !== PROVIDER.reference || !item.slot.component) continue;
    const id = item.step.component_id;
    if (capability === "t2va") {
      issues.push({ name: item.name, text: t("{name}（{id}）只用於 fl2va／ref2va：t2va 的元件組合不能包含 h3.reference 步驟（元件會回 MODEL_INCOMPATIBLE）", { name: item.name, id }), component: false });
      continue;
    }
    const variant = componentVariant(item.slot.component);
    if (variant !== wanted) issues.push({ name: item.name, text: t("{name}（{id}）載入的是 {variant} checkpoint；{capability} 需要 {wanted}", { name: item.name, id, variant, capability, wanted }), component: false });
  }

  return {
    id: pipeline.pipeline_id,
    label: pipeline.label.trim() || pipeline.pipeline_id,
    pipeline,
    steps,
    promptInput: prompt.name,
    final,
    capability,
    materialsInput,
    imageInput,
    teStepId: te?.step.step_id ?? null,
    ditStepId: dit?.step.step_id ?? null,
    teNodeId: te?.step.node_id ?? null,
    ditNodeId: dit?.step.node_id ?? null,
    ditVariant,
    referenceHint,
    ready: issues.length === 0,
    problems: issues.map((issue) => issue.text),
    notes,
    caveat: dit?.slot.component ? routeCaveat(dit.step, dit.slot.component, capability) : null,
    summary: summarize(issues),
  };
}

/** 所有可給 Studio 用的元件組合，順序與 GET /api/pipelines 相同（＝使用者設定的數量與順序）。 */
export function deriveStudioRoutes(pipelines: readonly WirePipeline[] | undefined, catalog: Catalog | undefined): StudioRoute[] {
  const index = indexCatalog(catalog);
  return (pipelines ?? []).flatMap((pipeline) => {
    const route = deriveRoute(pipeline, index);
    return route ? [route] : [];
  });
}

export function findRoute(routes: readonly StudioRoute[], id: string): StudioRoute | null {
  return routes.find((route) => route.id === id) ?? null;
}

const OPENING_BRACKETS = new Set([..."(（[［【「"]); // i18n-ignore
const CLOSING_BRACKETS = new Set([...")）]］】」"]); // i18n-ignore
const COLONS = new Set([...":："]); // i18n-ignore

/**
 * A component combination's label as lists show it. People name a combination 「名稱：接法」 (for example
 * 「參考生成（第二台）：TE→參考編碼→DiT→正式解碼」): the part before the first colon outside brackets is the name, the
 * rest describes the wiring and belongs in a tooltip or the detail. A colon inside the name's brackets (「參考生成（成品：
 * DiT 8 步）：…」) stays in the name, so its brackets stay balanced. A label without such a colon is all name.
 */
export function routeName(label: string): { name: string; description: string | null } {
  const text = label.trim();
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (OPENING_BRACKETS.has(char)) depth += 1;
    else if (CLOSING_BRACKETS.has(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && COLONS.has(char)) {
      const name = text.slice(0, index).trim();
      const description = text.slice(index + 1).trim();
      return name && description ? { name, description } : { name: text, description: null };
    }
  }
  return { name: text, description: null };
}

/** A Node's label without its parenthesized hardware note: 「node-a（GPU 0 + GPU 1）」 → 「node-a」. */
export function nodeShortName(label: string): string {
  return label.replace(/\s*[（(].*$/su, "").trim() || label.trim();
}

/** take／鏡頭上的路由名稱：元件組合還在就顯示名稱，否則顯示原本的 id。 */
export function routeDisplayLabel(routes: readonly StudioRoute[], id: string): string {
  return findRoute(routes, id)?.label ?? id;
}

export interface TakeRouteSummary {
  /** 渲染這個 take 的運算路由（元件組合）名稱；元件組合已刪除時是它的 ID。 */
  label: string;
  /** H3 任務（次要標記）；舊 take 沒有記錄時依契約由首幀接續判斷（有＝fl2va，沒有＝t2va）。 */
  task: RouteTask;
  /** 提示：完整名稱與 route ID。 */
  title: string;
}

/** 輸出卡上的「用哪個運算路由渲染」：主要顯示元件組合名稱，任務（t2va／fl2va／ref2va）只是次要標記。 */
export function takeRouteSummary(routes: readonly StudioRoute[], take: { route: string; task?: RouteTask; continuity?: unknown }): TakeRouteSummary {
  const label = routeDisplayLabel(routes, take.route);
  const known = findRoute(routes, take.route) !== null;
  const task: RouteTask = take.task ?? (take.continuity ? "fl2va" : "t2va");
  return {
    label,
    task,
    title: t("運算路由：{label}{value}{value2}・任務 {task}", { label, value: label === take.route ? "" : t("（{route}）", { route: take.route }), value2: known ? "" : t("；這個元件組合已不在清單上"), task }),
  };
}

/**
 * 沒有指定時挑哪個元件組合當預設：文字生成（t2va）優先，因為新鏡頭還沒有參考素材，也不是接續前一個鏡頭；
 * 同能力內就緒的優先。fl2va 需要首幀接續、ref2va 需要參考素材，排在後面。
 */
const CAPABILITY_ORDER: Record<RouteTask, number> = { t2va: 0, ref2va: 1, fl2va: 2 };

export function pickDefaultRoute(routes: readonly StudioRoute[]): StudioRoute | undefined {
  return [...routes].sort((a, b) => CAPABILITY_ORDER[a.capability] - CAPABILITY_ORDER[b.capability] || Number(b.ready) - Number(a.ready))[0];
}

/** 新鏡頭的路由：專案預設還存在就用它，否則依 pickDefaultRoute；都沒有時保留預設值。 */
export function defaultRouteFor(project: StudioProject, routes: readonly StudioRoute[]): string {
  if (findRoute(routes, project.defaults.route)) return project.defaults.route;
  return pickDefaultRoute(routes)?.id ?? project.defaults.route;
}

/** DiT 參數在鏡頭留空時的實際值來源：元件組合步驟參數優先，其次元件保存的 invoke 預設；都沒有＝元件內建預設（未回報）。 */
export interface ParameterDefault {
  value: number | null;
  source: "pipeline" | "component" | null;
}

function readDitParameter(step: WireStep | undefined, component: ComponentDescriptor | null | undefined, key: string): ParameterDefault {
  const fromStep = step?.parameters[key];
  if (typeof fromStep === "number") return { value: fromStep, source: "pipeline" };
  const invoke: unknown = component?.settings.stored.invoke;
  const fromComponent = isRecord(invoke) ? invoke[key] : undefined;
  if (typeof fromComponent === "number") return { value: fromComponent, source: "component" };
  return { value: null, source: null };
}

export function ditDefaults(route: StudioRoute | null): Record<"steps" | "video_shift" | "audio_shift", ParameterDefault> {
  const dit = route?.steps.find((item) => item.step.step_id === route.ditStepId);
  const read = (key: string) => readDitParameter(dit?.step, dit?.slot.component, key);
  return { steps: read("steps"), video_shift: read("video_shift"), audio_shift: read("audio_shift") };
}

// ---------------------------------------------------------------- 首幀接續、序列匯出

export interface ContinuitySupport {
  /** 路由是 fl2va（有首幀輸入）才支援。只用於「從前一個鏡頭接續」；素材庫圖片當首幀不需要取影格元件。 */
  supported: boolean;
  ready: boolean;
  problems: string[];
  summary: string;
  /** media.frame（在 DiT 所在的 Node 上）；不支援時為 null。 */
  frame: ComponentSlot | null;
}

function frameSlot(index: CatalogIndex, nodeId: string | null): ComponentSlot {
  const nodeLabel = nodeId ? (index.nodeLabel(nodeId) ?? nodeId.slice(0, 8)) : "—";
  const component = nodeId ? preferUsable(index.all.filter((item) => item.provider_id === PROVIDER.frame && item.node_id === nodeId)) : null;
  if (!component || !nodeId) {
    return { nodeId: nodeId ?? "", componentId: "", component: null, nodeLabel, usable: false, reason: t("{nodeLabel} 上沒有取出影格元件（media.frame）；首幀接續需要它", { nodeLabel }) };
  }
  return componentSlot(index, nodeId, component.component_id, SHORT_NAMES[PROVIDER.frame] ?? t("取影格"));
}

/** 首幀接續（previous_last）在這條路由上需要的條件：fl2va 元件組合本身就緒，加上 DiT 所在 Node 的 media.frame。 */
export function routeContinuity(route: StudioRoute | null, catalog: Catalog | undefined): ContinuitySupport {
  if (!route) return { supported: false, ready: false, problems: [ROUTE_MISSING], summary: ROUTE_MISSING, frame: null };
  if (route.capability !== "fl2va" || !route.imageInput) {
    const text = t("元件組合「{label}」是 {capability}，不支援首幀接續（需要 fl2va：media.image.v1 輸入接到 TE 的 first_frame）", { label: route.label, capability: route.capability });
    return { supported: false, ready: false, problems: [text], summary: text, frame: null };
  }
  const frame = frameSlot(indexCatalog(catalog), route.ditNodeId);
  const frameProblem = frame.usable ? [] : [frame.reason ?? t("取影格無法使用")];
  const problems = [...route.problems, ...frameProblem];
  const summary = problems.length === 0 ? t("就緒") : [...(route.ready ? [] : [route.summary]), ...frameProblem].join(t("；"));
  return { supported: true, ready: problems.length === 0, problems, summary, frame };
}

/** 序列匯出元件：可用的優先、其次在渲染（DiT）所在的 Node 上。 */
export function concatSlot(catalog: Catalog | undefined, preferNodeIds: readonly string[] = []): ComponentSlot {
  const index = indexCatalog(catalog);
  const candidates = index.all.filter((item) => item.provider_id === PROVIDER.concat);
  const score = (item: ComponentDescriptor) =>
    (item.state === "ready" || item.state === "busy" ? 2 : 0) + (index.online(item.node_id) === false ? -4 : 0) + (preferNodeIds.includes(item.node_id) ? 1 : 0);
  const chosen = [...candidates].sort((a, b) => score(b) - score(a))[0];
  if (!chosen) return { nodeId: "", componentId: "", component: null, nodeLabel: "—", usable: false, reason: t("找不到序列匯出元件（media.concat）；請到「元件修改・元件」新增") };
  return componentSlot(index, chosen.node_id, chosen.component_id, SHORT_NAMES[PROVIDER.concat] ?? t("序列匯出"));
}

// ---------------------------------------------------------------- 渲染引擎（Studio context 用）

export interface Engine {
  /** 元件組合與元件目錄都讀到才是 ready；之前的就緒判斷不可信。 */
  status: "loading" | "error" | "ready";
  error: string | null;
  routes: StudioRoute[];
  concat: ComponentSlot;
}

export function resolveEngine(input: { pipelines: readonly WirePipeline[] | undefined; catalog: Catalog | undefined; error: string | null }): Engine {
  const routes = deriveStudioRoutes(input.pipelines, input.catalog);
  const ditNodes = [...new Set(routes.flatMap((route) => (route.ditNodeId ? [route.ditNodeId] : [])))];
  const status = input.pipelines && input.catalog ? "ready" : input.error ? "error" : "loading";
  return { status, error: status === "error" ? input.error : null, routes, concat: concatSlot(input.catalog, ditNodes) };
}

/** 渲染引擎還不能判斷時的說明（讀取中或讀取失敗）；可以判斷時為 null。 */
export function engineUnavailable(engine: Pick<Engine, "status" | "error">): string | null {
  if (engine.status === "loading") return t("還在讀取元件組合與元件目錄");
  if (engine.status === "error") return t("無法讀取元件組合或元件目錄：{value}", { value: engine.error ?? t("未知錯誤") });
  return null;
}
