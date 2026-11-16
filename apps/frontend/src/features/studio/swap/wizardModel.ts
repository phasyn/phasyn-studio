// Pure derivations of the swap wizard: source facts (cut detection wins over the browser), the cuts in use, the compute
// route (default: the first ready ref2va pipeline) and its DiT's swap limit (per-segment limit by character count:
// maxFramesFor), the segment plan, the time estimate, how many segments fit in one run, and what blocks each step.
import { approximateTextTokens, type SegmentEtaInput } from "../model/eta";
import { FORMAT_PRESETS } from "../model/project";
import { ditDefaults, type StudioRoute } from "../model/routes";
import { cutKey, segmentKey, segmentSettings, STEP_IDS, type StepId, type SwapDraft } from "./draft";
import { characterLimitReason, maxFramesFor, referenceAreaFor, routeImageEdge, segmentsPerRun, swapLimitsFor, type ResolvedSwapLimit } from "./limits";
import { segmentPrompts, soundtrackSent } from "./job";
import { DEFAULT_HOLD_TAIL, maxSegments, planSegments, type SegmentPlan } from "./planner";
import type { ProbeSceneInfo } from "./probe";
import { dialogueBalanced } from "./prompt";
import { preparedArea, referenceRatioProblem } from "./referenceImage";
import type { DetectionView } from "./useCutDetection";
import { t } from "@/i18n";

export interface SourceFacts {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean | null;
  /** 資訊來源：probe＝切鏡偵測（ffprobe）、browser＝瀏覽器讀取。 */
  from: "probe" | "browser";
}

export interface WizardDerived {
  facts: SourceFacts | null;
  /** 偵測到的切鏡（秒；整支影片）。null＝還沒有偵測結果。 */
  detectedCuts: number[] | null;
  /** 分段使用的切鏡（偵測後沒有取消的＋手動加的；秒，排序）。 */
  enabledCuts: number[];
  plan: SegmentPlan;
  /** 可用的 ref2va 路由。 */
  routes: StudioRoute[];
  /** 選取的路由：草稿選的，沒選時用預設（defaultSwapRoute）；找不到時 null。 */
  route: StudioRoute | null;
  /** 路由 DiT 的換角上限（DiT 沒有宣告 limits.swap 時是保守的預設上限）。 */
  limit: ResolvedSwapLimit;
  /** 草稿的角色數（每段上限、參考圖面積與時間預估都依角色數）。 */
  characters: number;
  /** 這個角色數的每段上限：maxFramesFor(limit, characters)（角色越多，上限通常越小；數字來自 limits.swap）。 */
  frameLimit: number;
  /** 實際使用的每段上限：草稿的選擇（沒選＝frameLimit）與 frameLimit 取小。 */
  maxFrames: number;
  /** 這個角色數量測過的參考圖預處理後總面積（px²），超過時提醒；沒有資料時 null（不提醒）。 */
  measuredArea: number | null;
  /**
   * 每段的時間預估輸入（usePlanEta 用；估計器沒有資料時畫面顯示「尚無預估」）：送出的請求事實（ref2va、輸出尺寸、
   * 這段出現的角色圖、參考影片視窗與原聲、prompt 的概略 token 數）；第二段起與前一段同一個 run，元件已載入且暖機。
   */
  etaInputs: SegmentEtaInput[];
  /** 一個批次 run 放得下的段數（契約 256 個步驟÷路由每段的步驟數）；路由未知時 null。 */
  perRun: number | null;
  /** 角色圖預處理後的總面積（路由的參考圖短邊）；有圖片尺寸未知時為 null。 */
  area: number | null;
  /** 路由把參考圖縮放到的短邊（px）：官方 2048，或 TE 的 reference_image_short_edge。 */
  imageEdge: number;
  /** 選的畫面格式的像素數（寬×高）；格式未知時 null。 */
  outputPixels: number | null;
}

export function deriveWizard(
  draft: SwapDraft,
  input: { probe: ProbeSceneInfo | null; routes: readonly StudioRoute[] },
): WizardDerived {
  const probe = input.probe;
  const source = draft.source;
  const facts: SourceFacts | null = source
    ? {
        duration_seconds: probe?.duration_seconds ?? source.duration_seconds,
        width: probe?.width ?? source.width,
        height: probe?.height ?? source.height,
        has_audio: probe?.has_audio ?? source.has_audio,
        from: probe ? "probe" : "browser",
      }
    : null;
  const detectedCuts = probe?.scene_cuts_seconds ?? null;
  const disabled = new Set(draft.disabledCuts);
  const enabledCuts = [...new Set([...(detectedCuts ?? []).filter((cut) => !disabled.has(cutKey(cut))), ...draft.manualCuts.map((cut) => cut.seconds)])].sort((a, b) => a - b);
  const routes = input.routes.filter((route) => route.capability === "ref2va");
  const routeId = draft.routeId ?? defaultSwapRoute(routes);
  const route = routes.find((item) => item.id === routeId) ?? null;
  const limit = swapLimitsFor(route, draft.trial);
  const characters = draft.characters.length;
  // 每段上限依角色數：選的值或預設都不超過這個角色數的上限
  const frameLimit = maxFramesFor(limit, characters);
  const maxFrames = Math.min(draft.maxFrames ?? frameLimit, frameLimit);
  const duration = facts?.duration_seconds ?? null;
  const plan = planSegments({
    durationSeconds: duration,
    startSeconds: draft.startSeconds,
    endSeconds: draft.endSeconds ?? duration ?? draft.startSeconds,
    cutsSeconds: enabledCuts,
    maxFrames,
    crossfadeFrames: draft.crossfade,
    maxSegments: maxSegments(draft.audio === "original"),
    holdTail: draft.holdTail ? DEFAULT_HOLD_TAIL : null,
  });
  const images = draft.characters.map((character) => ({ width: character.image?.width ?? null, height: character.image?.height ?? null }));
  const imageEdge = routeImageEdge(route);
  const dit = route?.steps.find((item) => item.step.step_id === route.ditStepId)?.step ?? null;
  const steps = ditDefaults(route).steps.value;
  const preset = FORMAT_PRESETS.find((item) => item.id === draft.format) ?? FORMAT_PRESETS[0];
  const settings = segmentSettings(draft, plan);
  // 與建立專案時相同：只有選原影片音軌時才把原聲一起送（use_embedded_audio），prompt 也寫 <Audio 1>；prompt 就是專案會寫進鏡頭的那一份
  const hasAudio = soundtrackSent(draft.audio, facts?.has_audio);
  const prompts = segmentPrompts({ plan, notes: settings.notes, absent: settings.absent, style: draft.style, dialogueLanguage: draft.dialogueLanguage, characters: draft.characters, hasAudio });
  const etaInputs = plan.segments.map((segment, index): SegmentEtaInput => {
    const absent = new Set(settings.absent[index] ?? []);
    const present = draft.characters.filter((character) => !absent.has(character.id));
    return {
      routeId: route?.id ?? null,
      ditNodeId: dit?.node_id ?? null,
      ditComponentId: dit?.component_id ?? null,
      frames: segment.frames,
      characters: present.length,
      referenceVideoShortEdge: limit.referenceVideoShortEdge,
      steps,
      task: "ref2va",
      width: preset?.width,
      height: preset?.height,
      textTokens: approximateTextTokens(prompts[index]?.prompt ?? ""),
      textTokensApproximate: true,
      images: present.map((character) => ({ width: character.image?.width ?? null, height: character.image?.height ?? null })),
      // A held reference is held (picture and sound) to the generated length
      videos: [{ width: facts?.width ?? null, height: facts?.height ?? null, seconds: segment.hold ? segment.frames / plan.fps : segment.ref_end - segment.ref_start, withAudio: hasAudio }],
      continuesBatch: index > 0,
    };
  });
  return {
    facts,
    detectedCuts,
    enabledCuts,
    plan,
    routes,
    route,
    limit,
    characters,
    frameLimit,
    maxFrames,
    measuredArea: referenceAreaFor(limit, characters),
    etaInputs,
    perRun: segmentsPerRun(route),
    area: images.length > 0 ? preparedArea(images, imageEdge) : null,
    imageEdge,
    outputPixels: preset ? preset.width * preset.height : null,
  };
}

/** 切鏡偵測畫面狀態 → stepProblems 用的狀態（送出中算進行中）。 */
export function detectionStatus(view: DetectionView): StepContext["detection"] {
  if (view.status === "submitting" || view.status === "running") return "running";
  return view.status;
}

/** Default swap route: the first ready ref2va pipeline; none ready → null (the output step asks the user to choose). */
export function defaultSwapRoute(routes: readonly StudioRoute[]): string | null {
  return routes.find((route) => route.capability === "ref2va" && route.ready)?.id ?? null;
}

export interface StepContext {
  /** 切鏡偵測的狀態（目前的來源影片）。 */
  detection: "idle" | "running" | "succeeded" | "failed";
  detectionMessage?: string | null;
  engineReady: boolean;
}

export const SKIP_DETECTION_LABEL = t("不偵測，改用固定分段");

/** 每個步驟擋下前進（與建立）的原因；空陣列＝這一步沒問題。 */
export function stepProblems(draft: SwapDraft, derived: WizardDerived, context: StepContext): Record<StepId, string[]> {
  const out = Object.fromEntries(STEP_IDS.map((id) => [id, [] as string[]])) as Record<StepId, string[]>;
  const duration = derived.facts?.duration_seconds ?? null;
  if (draft.sourceUpload && draft.sourceUpload.state !== "failed") out.source.push(t("來源影片還在上傳"));
  if (!draft.source) out.source.push(t("選擇或上傳來源影片"));
  else {
    if (draft.startSeconds < 0) out.source.push(t("起點不能小於 0"));
    const end = draft.endSeconds ?? duration;
    if (end !== null && end <= draft.startSeconds) out.source.push(t("起點必須早於終點"));
    if (duration !== null && draft.endSeconds !== null && draft.endSeconds > duration + 1e-6) out.source.push(t("終點超過影片長度 {duration} 秒", { duration: duration.toFixed(3) }));
  }

  if (draft.characters.length === 0) out.characters.push(t("至少要有 1 個角色"));
  if (draft.characters.length > derived.limit.maxCharacters) out.characters.push(characterLimitReason(derived.limit));
  draft.characters.forEach((character, index) => {
    const name = t("角色 {index}", { index: index + 1 });
    const image = character.image;
    if (!image) out.characters.push(t("{name}還沒有圖片", { name }));
    else if (image.check === "checking") out.characters.push(t("{name}的圖片還在檢查", { name }));
    else if (image.check === "failed") out.characters.push(t("{name}：{value}", { name, value: image.error ?? t("圖片無法讀取") }));
    else {
      const ratio = referenceRatioProblem(image.width, image.height);
      if (ratio) out.characters.push(t("{name}：{ratio}", { name, ratio }));
    }
    if (!character.who.trim()) out.characters.push(t("{name}：填寫「取代影片中的誰」", { name }));
    if (!character.appearance.trim()) out.characters.push(t("{name}：填寫「外觀」", { name }));
  });

  if (context.detection === "running") out.cuts.push(t("切鏡偵測進行中：等它完成或取消"));
  else if (context.detection !== "succeeded" && !draft.skipDetection) {
    out.cuts.push(
      context.detection === "failed"
        ? t("切鏡偵測失敗：{value}。按「重新偵測」，或選「{skipDetectionLabel}」", { value: context.detectionMessage ?? t("沒有結果"), skipDetectionLabel: SKIP_DETECTION_LABEL })
        : t("先執行切鏡偵測，或選「{skipDetectionLabel}」", { skipDetectionLabel: SKIP_DETECTION_LABEL }),
    );
  }
  // More segments than one run holds are rendered in batches (the swap panel sends the next one), so it never blocks
  out.plan.push(...derived.plan.problems);
  const unpaired = derived.plan.segments.findIndex((segment) => !dialogueBalanced(draft.notes[segmentKey(derived.plan, segment)] ?? ""));
  if (unpaired >= 0) out.plan.push(t("第 {index} 段的備註有沒成對的 <d> 或 </d>：每句台詞都寫成 <d>[語言] 原文</d>", { index: unpaired + 1 }));

  if (!context.engineReady) out.output.push(t("還在讀取元件組合與元件目錄"));
  else if (derived.routes.length === 0) out.output.push(t("沒有 ref2va 元件組合：到「元件修改・元件組合」建立（參考素材輸入接到 TE，DiT 用 ref2va checkpoint）"));
  else if (!derived.route) out.output.push(t("選擇運算路由（ref2va 元件組合）"));
  if (!draft.title.trim()) out.output.push(t("填寫專案名稱"));
  if (draft.audio === "original" && derived.facts?.has_audio === false) out.output.push(t("來源影片沒有音軌：聲音改用「生成的聲音」"));
  return out;
}

/** 第一個有問題的步驟（建立時跳過去）；都沒有問題時為 null。 */
export function firstBlockedStep(problems: Record<StepId, string[]>): StepId | null {
  return STEP_IDS.find((id) => problems[id].length > 0) ?? null;
}

