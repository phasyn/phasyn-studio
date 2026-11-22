// 一次生成 run 的完整規劃（純函式，不送出）：以圖片所選的元件組合為範本，批次 N 張時共用「一個」文字條件步驟
// （以及前處理、參考編碼），只把 DiT 與它下游（VAE 解碼、合成）複製 N 份、各自用不同 seed（步驟 id 加 _0、_1…，
// 接線一起改寫）。輸出 image／image_white（批次加後綴）。參數依步驟元件的 provider 覆寫；元件的參數 schema 沒有宣告
// 某個必要參數時擋下並說明（不默默略過、不假裝套用），選用的參數（預覽、來源 take）不支援時不送並附註。
// seed -1 在這裡抽出實際值並回傳；不改圖片設定、不重試。不能生成時回傳繁中原因。
import type { FileRef, Port } from "@/api/generated/contracts";
import type { RunRequestBody, WireBinding, WireStep, WireTypedValue } from "@/api/types";
import { cloneJson } from "@/lib/json";
import { validateValue } from "@/lib/schema/validate";
import { declaredParams, declaredSnapshot, unsupportedImageControl } from "./declaredImage";
import type { ImageLibraryItem, ImageStudioProject, StudioImageShot } from "../types";
import { COMPOSE_METADATA_BUDGET, LIMITS, LINEAR_FIT_UNAVAILABLE, OUTPUT_IMAGE, OUTPUT_WHITE } from "./constants";
import type { ImageParamsSnapshot } from "./params";
import { orderedReferences, referenceProblems } from "./references";
import { findImageRoute, modeMismatch, parameterSupport, type ImageRoute, type ImageRouteStep } from "./routes";
import { randomSeed, resolveSeeds } from "./seeds";
import { cfgEnabled, paramProblems } from "./shots";
import { t } from "@/i18n";

/** 契約的 id 長度上限（step_id）。 */
const MAX_ID = 160;

export const ROUTE_MISSING = t("路由不存在：請在「基本」分頁選擇圖片元件組合");

export interface ImageRenderContext {
  routes: readonly ImageRoute[];
  /** 抽 seed（-1／每張隨機）；預設 crypto.getRandomValues，測試可注入。 */
  randomSeed?: () => number;
  /** 完成後自動把白底版加入素材庫（記在 params_snapshot）。 */
  autoLibrary?: boolean;
}

export interface PlannedImageBranch {
  index: number;
  /** "" 或 "_0"、"_1"…。 */
  suffix: string;
  seed: number;
  outputs: { image: string; image_white: string | null };
  snapshot: ImageParamsSnapshot;
}

export interface ImagePlan {
  body: RunRequestBody;
  branches: PlannedImageBranch[];
  /** 不擋生成的附註（例如 DiT 不接受預覽參數，這次沒有中間預覽）。 */
  notes: string[];
}

export type ImagePlanResult = { plan: ImagePlan; problem: null } | { plan: null; problem: string };

const fail = (problem: string): ImagePlanResult => ({ plan: null, problem });

/** required：不支援就擋下；optional：不支援就不送並附註；hint：元件宣告了才送（例如 TE 用不到的尺寸），不附註。 */
type ParamKind = "required" | "optional" | "hint";

interface ParamWriter {
  set: (target: Record<string, unknown>, item: ImageRouteStep, name: string, value: unknown, kind: ParamKind, why: string) => void;
  problems: string[];
  notes: string[];
}

function paramWriter(): ParamWriter {
  const problems: string[] = [];
  const notes: string[] = [];
  return {
    problems,
    notes,
    set(target, item, name, value, kind, why) {
      const support = parameterSupport(item.slot.component, name);
      if (kind === "hint" && support !== true) return;
      if (support === false) {
        const text = t("{name}（{component_id}）不接受參數 {name2}", { name: item.name, component_id: item.step.component_id, name2: name });
        if (kind === "required") problems.push(t("{text}：Image Studio 需要它來套用{why}", { text, why }));
        else {
          // 訊息只組一次再比對（翻譯後去重仍有效）
          const note = t("{text}：{why}", { text, why });
          if (!notes.includes(note)) notes.push(note);
        }
        return;
      }
      target[name] = value;
    },
  };
}

function libraryFile(library: readonly ImageLibraryItem[], itemId: string): FileRef | null {
  return library.find((item) => item.item_id === itemId)?.file ?? null;
}

/**
 * image.compose 的 metadata（寫進 PNG tEXt phasyn）：Studio 的專案／圖片／take、seed、批次位置、路由與 prompt。
 * canonical JSON（非 ASCII 會跳脫成 \\uXXXX）超過預算時不放 prompt 並註明（prompt 仍在 take 的參數紀錄）。
 */
export function composeMetadata(project: Pick<ImageStudioProject, "project_id">, shot: StudioImageShot, takeId: string, seed: number, batchIndex: number): Record<string, unknown> {
  const base = {
    source: "phasyn-studio.image-studio",
    studio: { project_id: project.project_id, image_shot_id: shot.image_shot_id, take_id: takeId },
    seed,
    batch: { size: shot.batch, index: batchIndex },
    route: shot.route,
    mode: shot.mode,
  };
  const withPrompt = { ...base, prompt: shot.prompt, negative_prompt: cfgEnabled(shot.guidance) ? shot.negative_prompt : null };
  // 估計 ASCII 跳脫後的大小：非 ASCII 字元算 6 bytes
  const size = Array.from(JSON.stringify(withPrompt)).reduce((sum, char) => sum + (char.charCodeAt(0) > 0x7e ? 6 : 1), 0);
  return size <= COMPOSE_METADATA_BUDGET ? withPrompt : { ...base, prompt: null, prompt_omitted: t("prompt 太長，沒有寫進 PNG metadata（完整內容在 Studio 的參數紀錄）") };
}

function fileValue(port: Port, file: FileRef): WireTypedValue | string {
  if (port.transport === "inline") return t("元件組合的輸入「{name}」是 inline 型別，不能送出圖片檔", { name: port.name });
  return { type_id: port.type_id, file };
}

/**
 * takeIds：與批次張數同長度（送出前決定，寫進合成步驟的來源 take）。回傳的 branches 與 takeIds 同順序。
 */
export function planImageRender(
  project: Pick<ImageStudioProject, "project_id" | "title" | "library">,
  shot: StudioImageShot,
  takeIds: readonly string[],
  context: ImageRenderContext,
  options: { label?: string } = {},
): ImagePlanResult {
  const params = paramProblems(shot, findImageRoute(context.routes, shot.route)?.declared ? 1 : undefined);
  if (params.length > 0) return fail(params.join(t("；")));
  if (takeIds.length !== shot.batch) return fail(t("內部錯誤：take 數量（{takeIdsCount}）與生成張數（{batch}）不同", { takeIdsCount: takeIds.length, batch: shot.batch }));
  if (shot.takes.length + shot.batch > LIMITS.takes) return fail(t("這張圖片的 take 最多 {takes} 個（目前 {takesCount}）：用「用這組參數新增一張圖片」在新的圖片繼續，或刪除不要的 run", { takes: LIMITS.takes, takesCount: shot.takes.length }));
  const route = findImageRoute(context.routes, shot.route);
  if (!route) return fail(ROUTE_MISSING);
  const mismatch = modeMismatch(route, shot.mode);
  if (mismatch != null && mismatch !== "") return fail(mismatch);
  if (!route.ready) return fail(t("元件組合「{label}」未就緒：{summary}", { label: route.label, summary: route.summary }));
  const library = project.library ?? [];
  const refProblems = referenceProblems(shot, library);
  if (refProblems.length > 0) return fail(refProblems.join(t("；")));

  const i2i = shot.mode === "i2i";
  const references = i2i ? orderedReferences(shot.references) : [];
  if (references.length > route.referenceCapacity) return fail(t("元件組合「{label}」只接受 {referenceCapacity} 張參考圖片（目前 {referencesCount} 張）", { label: route.label, referenceCapacity: route.referenceCapacity, referencesCount: references.length }));
  const maskItem = i2i ? shot.mask_item_id : null;
  if (maskItem !== null && !(route.maskInput != null && route.maskInput !== "")) return fail(t("元件組合「{label}」沒有遮罩輸入：停用遮罩，或改選有遮罩輸入的 i2i 元件組合", { label: route.label }));
  const unsupported = route.declared ? unsupportedImageControl(route.declared, shot) : null;
  if (unsupported !== null) return fail(t("這個圖片路由無法套用所選設定：{control}", { control: unsupported }));
  const cfg = !route.declared && cfgEnabled(shot.guidance);
  if (cfg && !(route.negativeInput != null && route.negativeInput !== "")) return fail(t("元件組合「{label}」沒有負面提示詞輸入（negative_prompt）：guidance > 1 的 CFG 無法使用；把 guidance 設為 1 以下，或改選有負面提示詞輸入的元件組合", { label: route.label }));
  if (!route.declared && shot.preview.mode === "linear_fit" && (LINEAR_FIT_UNAVAILABLE != null && LINEAR_FIT_UNAVAILABLE !== "")) return fail(t("線性擬合預覽不可用：{linearFitUnavailable}。在「採樣」分頁改成 VAE 縮圖或關閉預覽", { linearFitUnavailable: LINEAR_FIT_UNAVAILABLE }));
  // VAE 縮圖預覽需要 DiT 以 preview_vae 載入；沒有時這次不送預覽（附註），不讓第一次生成失敗。預覽不影響最終圖片。
  const previewMode = shot.preview.mode === "vae_thumbnail" && route.previewVae === false ? "off" : shot.preview.mode;
  const previewNote =
    previewMode === shot.preview.mode
      ? null
      : t("DiT（{value}）沒有載入預覽 VAE（preview_vae）：這次不會有中間預覽；要預覽請在元件設定啟用 preview_vae 後重新啟動元件", { value: route.ditComponent?.component_id ?? "?" });

  let seeds: number[];
  try {
    seeds = resolveSeeds(shot.seed, shot.seed_mode, shot.batch, context.randomSeed ?? randomSeed);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const single = shot.batch === 1;
  const writer = paramWriter();
  const branchIds = new Set(route.branchStepIds);
  const byId = new Map(route.steps.map((item) => [item.step.step_id, item]));
  const maskSent = maskItem !== null;
  const baseIndex = maskSent ? shot.base_index : null;

  // ---- 共用步驟（只跑一次）
  const steps: WireStep[] = [];
  const taken = new Set<string>();
  for (const id of route.sharedStepIds) {
    const item = byId.get(id);
    if (!item) continue;
    const parameters = cloneJson(item.step.parameters);
    if (route.declared) Object.assign(parameters, declaredParams(route.declared, id, shot, 0));
    else if (item.role === "prepare") {
      writer.set(parameters, item, "width", shot.width, "required", t("輸出尺寸"));
      writer.set(parameters, item, "height", shot.height, "required", t("輸出尺寸"));
      writer.set(parameters, item, "reference_resolution", shot.reference_resolution, "required", t("參考圖編碼解析度"));
      writer.set(parameters, item, "base_index", baseIndex, "required", t("底圖"));
      writer.set(parameters, item, "mask_invert", maskSent ? shot.mask_invert : false, "required", t("遮罩反轉"));
    } else if (item.role === "te") {
      writer.set(parameters, item, "cfg", cfg, "required", t("guidance（CFG 開關）"));
      writer.set(parameters, item, "width", shot.width, "hint", t("輸出尺寸"));
      writer.set(parameters, item, "height", shot.height, "hint", t("輸出尺寸"));
    }
    taken.add(id);
    steps.push({ ...cloneJson(item.step), parameters });
  }

  // ---- 每張圖一份（DiT 與它下游）
  const branches: PlannedImageBranch[] = [];
  const outputs: RunRequestBody["pipeline"]["outputs"] = {};
  for (let index = 0; index < shot.batch; index += 1) {
    const suffix = single ? "" : `_${String(index)}`;
    const seed = seeds[index] ?? 0;
    const takeId = takeIds[index] ?? "";
    const rename = (id: string) => (branchIds.has(id) ? `${id}${suffix}` : id);
    for (const id of route.branchStepIds) {
      const item = byId.get(id);
      if (!item) continue;
      const stepId = rename(id);
      if (stepId.length > MAX_ID || taken.has(stepId)) return fail(t("元件組合「{label}」的步驟 id「{stepId}」太長或重複，無法組成批次 run", { label: route.label, stepId }));
      taken.add(stepId);
      const parameters = cloneJson(item.step.parameters);
      if (route.declared) Object.assign(parameters, declaredParams(route.declared, id, shot, seed));
      else if (item.role === "dit") {
        writer.set(parameters, item, "width", shot.width, "required", t("輸出尺寸"));
        writer.set(parameters, item, "height", shot.height, "required", t("輸出尺寸"));
        writer.set(parameters, item, "steps", shot.steps, "required", t("採樣步數"));
        writer.set(parameters, item, "guidance", shot.guidance, "required", "guidance");
        writer.set(parameters, item, "sigma_schedule", shot.sigma_schedule, "required", t("sigma 排程"));
        writer.set(parameters, item, "flow_shift_mu", shot.flow_shift_mu, "required", "flow shift μ");
        writer.set(parameters, item, "seed", seed, "required", "seed");
        if (previewMode !== "off") writer.set(parameters, item, "preview", { mode: previewMode, every: shot.preview.every }, "optional", t("這次不會有中間預覽"));
        // 關閉預覽也要明確送出（範本可能預設開啟）；元件不接受 preview 參數時本來就沒有預覽
        else if (parameterSupport(item.slot.component, "preview") !== false) parameters["preview"] = { mode: "off", every: shot.preview.every };
      } else if (item.role === "decode") {
        writer.set(parameters, item, "mode", shot.decode, "required", t("解碼方式（完整／分塊）"));
      } else if (item.role === "compose") {
        writer.set(parameters, item, "metadata", composeMetadata(project, shot, takeId, seed, index), "optional", t("PNG 的 metadata 不會記錄 Studio 的圖片／take"));
      }
      const inputs: Record<string, WireBinding> = {};
      for (const [port, binding] of Object.entries(item.step.inputs)) {
        inputs[port] = "from_step" in binding ? { from_step: rename(binding.from_step), output: binding.output } : cloneJson(binding);
      }
      steps.push({ ...cloneJson(item.step), step_id: stepId, inputs, parameters });
    }
    const imageKey = `${OUTPUT_IMAGE}${suffix}`;
    outputs[imageKey] = { from_step: rename(route.image.from_step), output: route.image.output };
    let whiteKey: string | null = null;
    if (route.white) {
      whiteKey = `${OUTPUT_WHITE}${suffix}`;
      outputs[whiteKey] = { from_step: rename(route.white.from_step), output: route.white.output };
    }
    branches.push({
      index,
      suffix,
      seed,
      outputs: { image: imageKey, image_white: whiteKey },
      snapshot: {
        v: 1,
        mode: shot.mode,
        prompt: shot.prompt,
        negative_prompt: shot.negative_prompt,
        width: shot.width,
        height: shot.height,
        seed,
        requested_seed: shot.seed,
        seed_mode: shot.seed_mode,
        batch: shot.batch,
        batch_index: index,
        steps: shot.steps,
        guidance: shot.guidance,
        sigma_schedule: shot.sigma_schedule,
        flow_shift_mu: shot.flow_shift_mu,
        route: route.id,
        references: references.map((ref) => ({ item_id: ref.item_id, order: ref.order, file: libraryFile(library, ref.item_id) })),
        base_index: baseIndex,
        reference_resolution: shot.reference_resolution,
        mask_item_id: maskItem,
        mask_file: maskItem === null ? null : libraryFile(library, maskItem),
        mask_invert: maskSent ? shot.mask_invert : false,
        decode: shot.decode,
        preview: { ...shot.preview },
        outputs: { image: imageKey, image_white: whiteKey },
        ...(route.declared ? {
          studio_image: declaredSnapshot(route.declared, shot, seed),
        } : {}),
        auto_library: context.autoLibrary === true && (!route.declared || route.white !== null),
      },
    });
  }
  if (writer.problems.length > 0) return fail(writer.problems.join(t("；")));

  // ---- 元件組合的輸入（所有圖片共用）
  const inputs: Record<string, WireTypedValue> = {};
  for (const port of route.pipeline.inputs) {
    let value: WireTypedValue | string | null = null;
    if (port.name === route.promptInput) value = { type_id: port.type_id, value: shot.prompt };
    else if (port.name === route.negativeInput) value = route.declared !== undefined || cfg || port.required ? { type_id: port.type_id, value: shot.negative_prompt } : null;
    else if (route.declared?.referenceInputs.includes(port.name) === true) {
      const selected = references[route.declared.referenceInputs.indexOf(port.name)];
      const file = selected ? libraryFile(library, selected.item_id) : null;
      if (file) value = fileValue(port, file);
      else if (port.required) value = t("元件組合「{label}」需要參考圖片（必填輸入 {name}）", { label: route.label, name: port.name });
    } else if (port.name === route.referenceListInput) {
      // qimg.references.v1：[{file, label}]，順序＝送出順序；label 只記在前處理的 metadata（不進 prompt）
      const list = references.flatMap((ref) => {
        const item = library.find((entry) => entry.item_id === ref.item_id);
        return item ? [{ file: item.file, label: item.name.slice(0, 200) }] : [];
      });
      if (list.length > 0) value = { type_id: port.type_id, value: list };
      else if (port.required) value = t("元件組合「{label}」需要參考圖片（必填輸入 {name}）", { label: route.label, name: port.name });
    } else if (port.name === route.maskInput) {
      const file = maskItem === null ? null : libraryFile(library, maskItem);
      if (file) value = fileValue(port, file);
      else if (port.required) value = t("元件組合「{label}」的遮罩輸入（{name}）是必填：先繪製並保存遮罩", { label: route.label, name: port.name });
    } else if (port.required) {
      value = t("元件組合「{label}」的必填輸入「{name}」（{type_id}）Image Studio 無法提供", { label: route.label, name: port.name, type_id: port.type_id });
    }
    if (typeof value === "string") return fail(value);
    if (value) inputs[port.name] = value;
  }

  if (route.declared) {
    for (const step of steps) {
      const component = route.steps.find((item) => item.step.component_id === step.component_id && item.step.node_id === step.node_id)?.slot.component;
      const issue = validateValue(component?.settings.parameters_schema, step.parameters)[0];
      if (issue) return fail(t("步驟 {step} 的圖片參數不相容：{reason}", { step: step.step_id, reason: [issue.path, issue.message].filter(Boolean).join(" ") }));
    }
  }

  const label =
    options.label ?? t("Image Studio：{title}・{title2}{value}", { title: project.title, title2: shot.title, value: single ? "" : t("・{batch} 張", { batch: shot.batch }) });
  return {
    plan: {
      body: { pipeline: { pipeline_id: route.id, label, inputs: cloneJson(route.pipeline.inputs), steps, outputs }, inputs, label },
      branches,
      notes: route.declared ? route.notes : (previewNote != null && previewNote !== "") ? [previewNote, ...writer.notes] : writer.notes,
    },
    problem: null,
  };
}

export interface RenderPreflight {
  problem: string | null;
  notes: string[];
}

/** 屬性面板用：這張圖現在能不能生成（與送出時同一套檢查，不抽真的 seed、不送出）。 */
export function imageRenderPreflight(project: Pick<ImageStudioProject, "project_id" | "title" | "library">, shot: StudioImageShot, context: Omit<ImageRenderContext, "randomSeed">): RenderPreflight {
  const batch = Number.isInteger(shot.batch) && shot.batch >= LIMITS.batch.min && shot.batch <= LIMITS.batch.max ? shot.batch : 1;
  const takeIds = Array.from({ length: batch }, (_, index) => `preflight${String(index)}`);
  let counter = 0;
  const result = planImageRender(project, shot, takeIds, { ...context, randomSeed: () => counter++ });
  return { problem: result.problem, notes: result.plan?.notes ?? [] };
}
