// 一次渲染 run 的完整規劃：每個分支（鏡頭或變體）複製該鏡頭所選元件組合（pipeline）的步驟當範本，綁定 prompt／參考素材，
// 依步驟元件的 provider 覆寫 H3 參數（TE：task／寬高／幀數；DiT：seed／步數／shift）。批次時每個分支的步驟 id 與輸入名稱
// 加上同一個後綴，from_step 接線一起改寫。首幀（fl2va）有兩種來源：
//   從前一個鏡頭接續：另加一個 media.frame 步驟，接到元件組合的首幀輸入；前一個鏡頭也在這個 run 內時直接接它的成片
//   （同一 run 內依序執行），否則把它使用中的 take 當 run 輸入；
//   素材庫圖片：素材檔（media.image.v1）直接當元件組合的首幀輸入（沒有取影格步驟）。
// 純函式：不送出、不重試、不改鏡頭設定；不能渲染時回傳繁中原因，由呼叫端顯示。seed -1 在這裡抽出實際值並回傳。
import type { Catalog, Port, StudioProject, StudioShot, StudioTake, StudioTakeReference } from "@/api/generated/contracts";
import type { RunRequestBody, WireBinding, WireRun, WireStep, WireTypedValue } from "@/api/types";
import { describeConflicts, samplingConflicts, stepsContractProblem } from "@/lib/ditSampling";
import { cloneJson } from "@/lib/json";
import { compilePrompt } from "../prompt";
import { materialsFor, validateReferences } from "../references";
import {
  continuityMode,
  continuitySource,
  frameSelection,
  imageFirstFrameSource,
  imageTakeContinuity,
  predecessor,
  takeContinuity,
  type FrameSelection,
  type TakeContinuity,
} from "./continuity";
import { H3_FPS } from "./frames";
import { ditPlacement, rootsFirst } from "./lanes";
import { localId, RANDOM_SEED, randomSeed } from "./project";
import { ASSET_TYPE, ditDefaults, findRoute, IMAGE_TYPE, MATERIALS_TYPE, PROMPT_TYPE, PROVIDER, ROUTE_MISSING, routeContinuity, type RouteTask, type StudioRoute } from "./routes";
import { swapCastProblems } from "./swapCast";
import { takeReferences } from "./takeRefs";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { applyPromptPlugins, pluginBlockItems, pluginBlockText, takePluginFields, type PluginRegistry } from "./promptPlugins";

/** 契約的 id 長度上限（step_id、輸入名稱）。 */
const MAX_ID = 160;

export interface RenderContext {
  /** Studio 路由（元件組合）；由 routes.ts deriveStudioRoutes 推導。 */
  routes: readonly StudioRoute[];
  /** 元件目錄（找首幀接續用的 media.frame）。 */
  catalog: Catalog | undefined;
  /** 抽 seed（-1＝隨機）；預設 crypto.getRandomValues，測試可注入。 */
  randomSeed?: () => number;
  /** 主控的插件登錄表；沒有傳時用目前讀到的那一份（送出時就是當下的登錄表）。 */
  plugins?: PluginRegistry;
}

export interface PlannedBranch {
  shotId: string;
  /** "" 或 "_0"、"_1"…（批次／變體）。 */
  suffix: string;
  /** run 輸出鍵（final／final_n），寫進 take.output_key。 */
  outputKey: string;
  /** 實際送出的 seed（-1 已換成隨機值）。 */
  seed: number;
  task: RouteTask;
  /** 鏡頭的路由（元件組合 id）。 */
  route: string;
  /** 實際送出的參考素材（ref2va 以外為空陣列）。 */
  references: StudioTakeReference[];
  /** 首幀紀錄（從前一個鏡頭接續或素材庫圖片；沒有首幀時為 null）。 */
  continuity: TakeContinuity | null;
}

export interface RenderPlan {
  body: RunRequestBody;
  /** 與傳入的鏡頭同順序。 */
  branches: PlannedBranch[];
  /** 規劃時專案選用的插件貢獻與它們的內容版本（記在每個 take 上）。 */
  plugins: Pick<StudioTake, "prompt_plugins" | "prompt_plugin_revs">;
}

/**
 * 不能渲染時要去哪裡修：engine＝渲染引擎（元件組合、Node 上的元件、取影格元件）；shot＝鏡頭的生成設定（首幀、方式、
 * 元件組合的選擇）；plugins＝專案選用的 Prompt 插件；prompt＝prompt 的寫法；references＝參考素材。
 */
export type RenderProblemKind = "engine" | "shot" | "plugins" | "prompt" | "references";

export interface RenderProblem {
  kind: RenderProblemKind;
  /** 一句話（按鈕的停用原因、批次清單的提示）。 */
  text: string;
  /** 逐項原因（每一條不符合的插件規則、每一個參考素材問題）；只有一項時為空陣列。 */
  items: readonly string[];
}

export type RenderPlanResult = { plan: RenderPlan; problem: null; blocked: null } | { plan: null; problem: string; blocked: RenderProblem };

const fail = (problem: string, kind: RenderProblemKind = "engine", items: readonly string[] = []): RenderPlanResult => ({
  plan: null,
  problem,
  blocked: { kind, text: problem, items: items.length > 1 ? items : [] },
});

/** 在 taken 中找一個還沒用過的 id：先試 base＋suffix，再試 base2＋suffix…（後綴永遠在最後，分支判斷才會一致）。 */
function uniqueId(base: string, suffix: string, taken: Set<string>): string {
  let candidate = `${base}${suffix}`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}${n}${suffix}`;
  taken.add(candidate);
  return candidate;
}

/** H3 參數覆寫（依步驟元件的 provider）；其餘參數沿用元件組合範本。 */
function overrideParameters(providerId: string | null, base: Record<string, unknown>, values: { task: RouteTask; shot: StudioShot; project: StudioProject; seed: number }): Record<string, unknown> {
  const parameters = cloneJson(base);
  if (providerId === PROVIDER.te) {
    parameters.task = values.task;
    parameters.width = values.project.format.width;
    parameters.height = values.project.format.height;
    parameters.frames = values.shot.frames;
  } else if (providerId === PROVIDER.dit) {
    parameters.seed = values.seed;
    if (values.shot.steps !== null) parameters.steps = values.shot.steps;
    if (values.shot.video_shift !== null) parameters.video_shift = values.shot.video_shift;
    if (values.shot.audio_shift !== null) parameters.audio_shift = values.shot.audio_shift;
  }
  return parameters;
}

/** run 名稱的首幀標記：（首幀接續）／（圖片首幀）；批次時加「含」。沒有首幀時是空字串。 */
function firstFrameLabel(branches: readonly PlannedBranch[], batch: boolean): string {
  const kinds = [...new Set(branches.flatMap((branch) => (branch.continuity ? [branch.continuity.mode === "image" ? t("圖片首幀") : t("首幀接續")] : [])))];
  return kinds.length === 0 ? "" : t("（{value}{kinds}）", { value: batch ? t("含") : "", kinds: formatList(kinds) });
}

/**
 * shots：要渲染的分支（變體＝同一鏡頭、不同 seed）；takeIds 與 shots 同順序（送出前先決定：批次內的接續要引用前一個分支的 take）。
 */
export function planRender(
  project: StudioProject,
  shots: readonly StudioShot[],
  takeIds: readonly string[],
  context: RenderContext,
  options: { label?: string } = {},
): RenderPlanResult {
  if (shots.length === 0) return fail(t("沒有要渲染的鏡頭"), "shot");
  const single = shots.length === 1;
  const draw = context.randomSeed ?? randomSeed;
  const library = project.library ?? [];
  const steps: WireStep[] = [];
  const ports: Port[] = [];
  const inputs: Record<string, WireTypedValue> = {};
  const outputs: RunRequestBody["pipeline"]["outputs"] = {};
  const branches: PlannedBranch[] = [];
  /** 每個分支的成片來源（批次內的接續要接它）。 */
  const finals: { from_step: string; output: string }[] = [];
  const takenSteps = new Set<string>();
  const takenInputs = new Set<string>();

  for (const [index, shot] of shots.entries()) {
    const suffix = single ? "" : `_${index}`;
    const name = shot.title || shot.shot_id;
    const route = findRoute(context.routes, shot.route);
    if (!route) return fail(t("「{name}」：{routeMissing}", { name, routeMissing: ROUTE_MISSING }));
    if (!route.ready) return fail(t("「{name}」的元件組合「{label}」未就緒：{summary}", { name, label: route.label, summary: route.summary }));
    const ditComponent = route.steps.find((item) => item.step.step_id === route.ditStepId)?.slot.component;
    if (ditComponent) {
      const overrides = Object.fromEntries(Object.entries({ steps: shot.steps, video_shift: shot.video_shift, audio_shift: shot.audio_shift }).filter(([, value]) => value !== null));
      const contract = samplingConflicts(overrides, ditComponent).filter((item) => item.blocking);
      if (contract.length > 0) return fail(t("「{name}」：{contract}", { name, contract: describeConflicts(contract, ditComponent.component_id, t("畫質分頁")) }));
      // 實際步數（鏡頭 → 元件組合 → 元件保存設定）不在 DiT 回報的合約步數內：元件保存的值本身錯了也先擋下，不讓前面的步驟白跑
      const stepsProblem = stepsContractProblem(shot.steps ?? ditDefaults(route).steps.value, ditComponent);
      if (stepsProblem !== null) return fail(t("「{name}」：{contract}", { name, contract: stepsProblem }));
    }

    // H3 任務：有首幀（接續前一個鏡頭或素材庫圖片）一定是 fl2va；其餘由元件組合決定（fl2va 元件組合沒有首幀就不能渲染，也不退回 t2va）
    const mode = continuityMode(shot);
    const continuing = mode === "previous_last";
    let task: RouteTask;
    if (mode !== "none") {
      if (route.capability !== "fl2va" || !route.imageInput) {
        const [wanted, needs] = continuing ? [t("設定了從前一個鏡頭接續"), t("首幀接續")] : [t("設定了素材庫圖片當首幀"), t("首幀圖片")];
        return fail(t("「{name}」{wanted}，但元件組合「{label}」是 {capability}：{needs}需要 fl2va 元件組合", { name, wanted, label: route.label, capability: route.capability, needs }), "shot");
      }
      task = "fl2va";
    } else if (route.capability === "fl2va") {
      return fail(t("「{name}」的元件組合「{label}」需要首幀（fl2va）：開啟「從前一個鏡頭接續」或選一張素材庫圖片當首幀，或改選 t2va 元件組合", { name, label: route.label }), "shot");
    } else {
      task = route.capability;
    }

    // 素材庫圖片當首幀：素材檔直接是元件組合的首幀輸入（比例必須與專案畫面相同，否則會被拉伸變形）
    let imageValue: WireTypedValue | null = null;
    let imageName: string | null = null;
    let record: TakeContinuity | null = null;
    if (mode === "image") {
      const result = imageFirstFrameSource(project, shot);
      if (!result.source) return fail(t("「{name}」的首幀圖片：{problem}", { name, problem: result.problem }), "shot");
      imageValue = { type_id: IMAGE_TYPE, file: result.source.item.file };
      imageName = result.source.item.name;
      record = imageTakeContinuity(result.source);
    }

    const references = shot.references ?? [];
    // 專案的插件貢獻：違反規則、生成設定的要求不符合或登錄表讀不到就不送出；風格與站位描述加進 prompt（送出的文字，鏡頭本身不變）
    const plugged = applyPromptPlugins(shot.prompt, project.prompt_plugins, { project, shot, route }, context.plugins);
    if (plugged.problems.length > 0 || plugged.findings.length > 0) {
      return fail(t("「{name}」不符合專案的 Prompt 插件：{blocked}", { name, blocked: pluginBlockText(plugged) }), "plugins", pluginBlockItems(plugged));
    }
    const compiled = compilePrompt(plugged.prompt, references);
    if (compiled.problems.length > 0) return fail(t("「{name}」的 prompt：{problems}", { name, problems: compiled.problems.join(t("；")) }), "prompt", compiled.problems);
    // 換角表：表外角色不換角、subject 的外觀要和它的圖是同一個角色（swapCast.ts）
    const castProblems = swapCastProblems(plugged.prompt, references, library);
    if (castProblems.length > 0) return fail(t("「{name}」的換角對照：{problems}", { name, problems: castProblems.join(t("；")) }), "prompt", castProblems);
    if (task !== "ref2va" && compiled.mentionedAliases.length > 0) {
      const map = formatList(compiled.mentionedAliases.map((alias) => `@${alias}`));
      // 元件組合其實接了參考素材輸入、只是 DiT 不是 ref2va checkpoint：說出原因，不只說「不支援」
      if (route.referenceHint) return fail(t("「{name}」的 prompt 用到參考素材（{map}），但元件組合「{label}」不支援參考素材：{hint}", { name, map, label: route.label, hint: route.referenceHint }), "shot");
      return fail(t("「{name}」的 prompt 用到參考素材（{map}），但元件組合「{label}」不支援參考素材（需要 ref2va 元件組合）", { name, map, label: route.label }), "shot");
    }
    let materials: unknown = null;
    let sent: StudioTakeReference[] = [];
    if (task === "ref2va") {
      // A reference video held after its end counts as the shot's generated length (2–15 s and the total per kind)
      const problems = validateReferences(references, library, { generatedSeconds: shot.frames / H3_FPS });
      if (problems.length > 0) return fail(t("「{name}」的參考素材：{problems}", { name, problems: problems.join(t("；")) }), "references", problems);
      materials = materialsFor(references, library);
      sent = takeReferences(references, library);
    }

    // 範本的步驟 id 與輸入名稱（批次加後綴）
    const stepIds = new Map(route.steps.map((item) => [item.step.step_id, `${item.step.step_id}${suffix}`]));
    for (const id of stepIds.values()) {
      if (id.length > MAX_ID || takenSteps.has(id)) return fail(t("元件組合「{label}」的步驟 id「{id}」太長或重複，無法組成批次 run", { label: route.label, id }));
      takenSteps.add(id);
    }
    const inputNames = new Map<string, string>();
    for (const port of route.pipeline.inputs) {
      const renamed = uniqueId(port.name, suffix, takenInputs);
      if (renamed.length > MAX_ID) return fail(t("元件組合「{label}」的輸入名稱「{name}」太長，無法組成批次 run", { label: route.label, name: port.name }));
      inputNames.set(port.name, renamed);
    }

    // 首幀接續：取影格步驟（DiT 所在 Node 的 media.frame）→ 元件組合的首幀輸入
    let frameBinding: WireBinding | null = null;
    if (continuing) {
      const support = routeContinuity(route, context.catalog);
      const frame = support.frame;
      if (!support.ready || !frame?.component) return fail(t("「{name}」的首幀接續無法渲染：{summary}", { name, summary: support.summary }));
      const before = predecessor(project, shot.shot_id).previous;
      const previous = before?.shot ?? null;
      const inBatch = previous ? shots.findIndex((item, at) => at < index && item.shot_id === previous.shot_id) : -1;
      let video: WireBinding;
      let selection: FrameSelection;
      const sourceFinal = inBatch >= 0 ? finals[inBatch] : undefined;
      if (before && previous && sourceFinal) {
        selection = frameSelection(before, null);
        video = { from_step: sourceFinal.from_step, output: sourceFinal.output };
        record = {
          mode: "previous_last",
          source_shot_id: previous.shot_id,
          source_take_id: takeIds[inBatch] ?? "",
          source_frame_index: selection.position === "index" ? selection.frame_index : null,
          first_frame: null,
        };
      } else {
        const result = continuitySource(project, shot);
        if (!result.source) return fail(t("「{name}」不能從前一個鏡頭接續：{problem}", { name, problem: result.problem }), "shot");
        const previousInput = uniqueId("previous", suffix, takenInputs);
        ports.push({
          name: previousInput,
          type_id: ASSET_TYPE,
          required: true,
          transport: "inline",
          description: t("前一個鏡頭「{value}」的 take（取首幀）", { value: result.source.shot.title || result.source.shot.shot_id }),
        });
        inputs[previousInput] = { type_id: ASSET_TYPE, value: result.source.asset };
        video = { from_input: previousInput };
        selection = result.source.frame;
        record = takeContinuity(result.source);
      }
      const frameId = uniqueId("frame", suffix, takenSteps);
      steps.push({ step_id: frameId, node_id: frame.nodeId, component_id: frame.componentId, inputs: { video }, parameters: { ...selection } });
      outputs[`first_frame${suffix}`] = { from_step: frameId, output: "image" };
      frameBinding = { from_step: frameId, output: "image" };
    }

    // 元件組合的輸入：prompt、參考素材（ref2va）、首幀圖片（素材庫）；接續前一個鏡頭時首幀輸入改由取影格步驟提供。
    // 其他必填輸入 Studio 無法提供就不送出
    for (const port of route.pipeline.inputs) {
      if (frameBinding && port.name === route.imageInput) continue;
      const renamed = inputNames.get(port.name) ?? port.name;
      const isPrompt = port.name === route.promptInput;
      const isMaterials = task === "ref2va" && port.name === route.materialsInput;
      const isImage = imageValue !== null && port.name === route.imageInput;
      if (!isPrompt && !isMaterials && !isImage && port.required) return fail(t("元件組合「{label}」的必填輸入「{name}」（{type_id}）Studio 無法提供", { label: route.label, name: port.name, type_id: port.type_id }));
      ports.push({ ...port, name: renamed, description: isPrompt ? name : isImage ? t("「{name}」的首幀圖片：{value}", { name, value: imageName ?? "" }) : port.description });
      if (isPrompt) inputs[renamed] = { type_id: PROMPT_TYPE, value: compiled.text };
      else if (isMaterials) inputs[renamed] = { type_id: MATERIALS_TYPE, value: materials };
      else if (isImage && imageValue) inputs[renamed] = imageValue;
    }

    const seed = shot.seed === RANDOM_SEED ? draw() : shot.seed;
    const rewrite = (binding: WireBinding): WireBinding => {
      if ("from_step" in binding) return { from_step: stepIds.get(binding.from_step) ?? `${binding.from_step}${suffix}`, output: binding.output };
      if ("from_input" in binding) {
        if (frameBinding && binding.from_input === route.imageInput) return frameBinding;
        return { from_input: inputNames.get(binding.from_input) ?? binding.from_input };
      }
      return cloneJson(binding);
    };
    for (const item of route.steps) {
      const template = item.step;
      steps.push({
        ...template,
        step_id: stepIds.get(template.step_id) ?? template.step_id,
        inputs: Object.fromEntries(Object.entries(template.inputs).map(([port, binding]) => [port, rewrite(binding)])),
        parameters: overrideParameters(item.providerId, template.parameters, { task, shot, project, seed }),
      });
    }

    const outputKey = `final${suffix}`;
    const final = { from_step: stepIds.get(route.final.from_step) ?? `${route.final.from_step}${suffix}`, output: route.final.output };
    outputs[outputKey] = final;
    finals.push(final);
    branches.push({ shotId: shot.shot_id, suffix, outputKey, seed, task, route: shot.route, references: sent, continuity: record });
  }

  const first = shots[0];
  const label = options.label ?? (single && first ? t("Studio：{title}・{title2}{firstFrameLabel}", { title: project.title, title2: first.title, firstFrameLabel: firstFrameLabel(branches, false) }) : t("Studio：{title}・批次 {shotsCount} 鏡頭{firstFrameLabel}", { title: project.title, shotsCount: shots.length, firstFrameLabel: firstFrameLabel(branches, true) }));
  // 用到不只一顆 DiT 的批次：每個分支不等其他步驟的步驟（文字條件）排在最前面。主控依步驟順序啟動就緒的步驟，而文字編碼器可能和另一顆
  // DiT 共用同一張 GPU，這樣長時間的 DiT 呼叫不會排到後面鏡頭的文字條件前面。
  const placements = new Set(shots.flatMap((shot) => ditPlacement(findRoute(context.routes, shot.route)) ?? []));
  const ordered = placements.size > 1 ? rootsFirst(steps) : steps;
  const routeIds = [...new Set(shots.map((shot) => shot.route))];
  // 同一個元件組合時沿用它的 id（執行紀錄可以對回元件組合）；混用多個元件組合的批次另外命名
  const pipelineId = routeIds.length === 1 && routeIds[0] ? routeIds[0] : "studio-batch-render";
  const plugins = takePluginFields(project.prompt_plugins, context.plugins);
  return { plan: { body: { pipeline: { pipeline_id: pipelineId, label, inputs: ports, steps: ordered, outputs }, inputs, label }, branches, plugins }, problem: null, blocked: null };
}

/** 屬性面板用：這個鏡頭現在能不能渲染（與送出時同一套檢查，不抽 seed、不送出）；可以時為 null。 */
export function renderProblem(project: StudioProject, shot: StudioShot, context: Omit<RenderContext, "randomSeed">): RenderProblem | null {
  return planRender(project, [shot], ["preflight"], { ...context, randomSeed: () => 0 }).blocked;
}

/**
 * 送出渲染 run 之後要加進專案的 take（take id 在送出前決定、state＝rendering、記下實際的 seed、路由、任務與參考素材）。
 * branches 與 plan.branches 同順序。
 */
export function renderTakes(
  project: StudioProject,
  branches: readonly StudioShot[],
  plan: RenderPlan,
  takeIds: readonly string[],
  run: Pick<WireRun, "run_id" | "created_at">,
): { shotId: string; take: StudioTake }[] {
  return plan.branches.map((branch, index) => {
    const shot = branches[index];
    const take: StudioTake = {
      take_id: takeIds[index] ?? localId("t"),
      run_id: run.run_id,
      output_key: branch.outputKey,
      created_at: run.created_at,
      state: "rendering",
      prompt: shot?.prompt ?? "",
      ...plan.plugins,
      seed: branch.seed,
      frames: shot?.frames ?? 0,
      width: project.format.width,
      height: project.format.height,
      route: branch.route,
      steps: shot?.steps ?? null,
      asset: null,
      video_latent: null,
      error: null,
      timings_ms: {},
      continuity: branch.continuity,
      task: branch.task,
      references: branch.references,
    };
    return { shotId: branch.shotId, take };
  });
}
