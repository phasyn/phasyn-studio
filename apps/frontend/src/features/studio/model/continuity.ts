import { firstFrameCount } from "@/lib/json";
// 鏡頭的首幀（MiniMax H3 fl2va），兩種來源：
//   previous_last＝時間軸上前一個鏡頭片段最後顯示的那一格（它使用中的 take）：run 的步驟由 renderPlan.ts 以 fl2va
//                  元件組合為範本組出，另加一個 media.frame 步驟接到元件組合的首幀輸入；
//   image＝專案素材庫的一張圖片（例如 Image Studio 生成的白底版）：原檔直接當成元件組合的首幀輸入（media.image.v1，不取影格）。
// 純函式：找來源、說明不能用的原因、從 run 讀回實際使用的首幀。
// fl2va 會把首幀當條件重新生成第 0 幀（vendored runtime：keyframe 條件以 t=0.999 雜訊增強），接點接近但不是逐像素相同；
// 第一張首幀會被拉伸（stretch_lanczos）到專案畫面，所以來源的比例必須與專案相同，否則畫面變形。
import type { Asset, FileRef, StudioLibraryItem, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { parseRunStep, typedFile, type WireRun } from "@/api/types";
import { isImageStudioMask } from "../references/materials";
import { branchStepIds, takeOutcome, type TakeOutcome } from "./pipelines";
import { clipEnabled, clipEnd, sourceFrameAtTimeline, trackClips } from "../editor/model";
import { projectTimeline } from "../editor/sources";
import { primaryVideoTrack } from "../editor/timelineGeometry";
import { H3_FPS } from "./frames";
import { activeTake } from "./project";
import type { ContinuitySupport } from "./routes";
import { t } from "@/i18n";

export type ContinuityMode = NonNullable<StudioShot["continuity"]>["mode"];
export type TakeContinuity = NonNullable<StudioTake["continuity"]>;
export type PreviousTakeContinuity = Extract<TakeContinuity, { mode: "previous_last" }>;
export type ImageTakeContinuity = Extract<TakeContinuity, { mode: "image" }>;

/** 缺少欄位（舊專案）＝none。 */
export function continuityMode(shot: StudioShot): ContinuityMode {
  return shot.continuity?.mode ?? "none";
}

/** 鏡頭有沒有首幀（前一個鏡頭或素材庫圖片）：有就是 fl2va。 */
export function hasFirstFrame(shot: Pick<StudioShot, "continuity">): boolean {
  const mode = shot.continuity?.mode ?? "none";
  return mode !== "none";
}

/** 以素材庫圖片當首幀時的 item_id；其他模式為 null。 */
export function firstFrameItemId(shot: Pick<StudioShot, "continuity">): string | null {
  return shot.continuity?.mode === "image" ? shot.continuity.item_id : null;
}

/** 鏡頭在成片裡接在誰後面：第一條影像軌上，它的第一個片段之前最近的那個鏡頭片段，以及那個片段最後顯示的素材影格。 */
export interface Predecessor {
  shot: StudioShot;
  /** 前一個片段可見範圍的最後一個素材影格（時間軸影格率下的素材影格序號）。 */
  lastSourceFrame: number;
  /** 時間軸影格率（素材影格換算成 take 自己的影格時使用）。 */
  fps: StudioProject["format"]["fps"];
}

export type PredecessorResult = { previous: Predecessor; problem: null } | { previous: null; problem: string };

/**
 * 「前一個鏡頭」由時間軸決定（片段的先後就是成片的先後），不看鏡頭清單的順序。停用的片段與不是鏡頭的素材不算；
 * 同一個鏡頭被分割成幾段時，接的是它第一段之前的鏡頭。
 */
export function predecessor(project: StudioProject, shotId: string): PredecessorResult {
  const result = projectTimeline(project);
  if (!result.ok) return { previous: null, problem: result.error };
  const timeline = result.value;
  const track = primaryVideoTrack(timeline);
  const clips = track ? trackClips(timeline, track.track_id) : [];
  const shotOf = (sourceId: string) => timeline.sources.find((source) => source.source_id === sourceId)?.shot_id ?? null;
  const index = clips.findIndex((clip) => shotOf(clip.source_id) === shotId);
  if (index < 0) return { previous: null, problem: t("這個鏡頭不在時間軸上：先加入時間軸，才知道它接在哪個鏡頭後面") };
  for (let i = index - 1; i >= 0; i -= 1) {
    const clip = clips[i];
    const id = clip ? shotOf(clip.source_id) : null;
    const shot = (id != null && id !== "") && id !== shotId ? project.shots.find((item) => item.shot_id === id) : undefined;
    if (!clip || !shot || !clipEnabled(clip)) continue;
    return { previous: { shot, lastSourceFrame: sourceFrameAtTimeline(clip, clipEnd(clip) - 1), fps: timeline.fps }, problem: null };
  }
  return { previous: null, problem: t("這是序列中的第一個鏡頭：前面沒有鏡頭可以接續") };
}

/** media.frame 的參數：前一個片段顯示到素材的最後一格時取最後一個可解碼影格；否則取它實際顯示的最後一格。 */
export type FrameSelection = { position: "last" } | { position: "index"; frame_index: number };

/** take 為 null＝前一個鏡頭在同一個 run 內重新渲染（以計畫影格數判斷是不是最後一格）。 */
export function frameSelection(previous: Predecessor, take: StudioTake | null): FrameSelection {
  const asset = take?.state === "succeeded" ? take.asset : null;
  const total = Math.max(1, firstFrameCount([asset?.frame_count, take?.frames], previous.shot.frames));
  const takeFps = asset?.fps ? asset.fps.num / asset.fps.den : H3_FPS;
  const index = Math.floor((previous.lastSourceFrame * takeFps * previous.fps.den) / previous.fps.num);
  return index < total - 1 ? { position: "index", frame_index: Math.max(0, index) } : { position: "last" };
}

export interface ContinuitySource {
  /** 前一個鏡頭。 */
  shot: StudioShot;
  /** 它使用中的 take（成功且完整）。 */
  take: StudioTake;
  asset: Asset;
  frame: FrameSelection;
}

export type ContinuitySourceResult = { source: ContinuitySource; problem: null } | { source: null; problem: string };

/** 前一個鏡頭可以拿來接續的 take；不行時回傳原因（繁中）。 */
export function continuitySource(project: StudioProject, shot: StudioShot): ContinuitySourceResult {
  const found = predecessor(project, shot.shot_id);
  if (!found.previous) return { source: null, problem: found.problem };
  const previous = found.previous.shot;
  const name = t("前一個鏡頭「{value}」", { value: previous.title || previous.shot_id });
  const take = activeTake(previous);
  if (!take) {
    const rendering = previous.takes.some((item) => item.state === "rendering");
    return { source: null, problem: rendering ? t("{name}還在渲染；完成後才能接續", { name }) : t("{name}還沒有可用的 take：先渲染它", { name }) };
  }
  if (take.state !== "succeeded" || !take.asset) return { source: null, problem: t("{name}使用中的 take 沒有成功完成", { name }) };
  const asset = take.asset;
  if (!asset.complete) return { source: null, problem: t("{name}的影片不完整（complete=false），不能從半成品取影格", { name }) };
  const { width, height } = project.format;
  if (asset.width !== width || asset.height !== height) {
    return {
      source: null,
      problem: t("{name}的 take 是 {width}×{height}，專案是 {width2}×{height2}：首幀會被拉伸到新畫布而變形；先以目前解析度重新渲染前一個鏡頭", { name, width: asset.width, height: asset.height, width2: width, height2: height }),
    };
  }
  return { source: { shot: previous, take, asset, frame: frameSelection(found.previous, take) }, problem: null };
}

/** 不能用「從前一個鏡頭接續」渲染的原因（來源，再來是路由的 fl2va／取影格條件）；可以時為 null。 */
export function continuityProblem(project: StudioProject, shot: StudioShot, support?: ContinuitySupport): string | null {
  const { problem } = continuitySource(project, shot);
  if (problem != null && problem !== "") return problem;
  if (support && !support.ready) return support.supported ? t("首幀接續需要的元件未就緒：{summary}", { summary: support.summary }) : support.summary;
  return null;
}

/** 預覽用：要取的來源影格序號（last 時以 Asset 的 frame_count 推算；實際序號以 media.frame 的解碼計數為準）。 */
export function sourceFrameIndex(source: ContinuitySource): number {
  return source.frame.position === "index" ? source.frame.frame_index : Math.max(0, source.asset.frame_count - 1);
}

/** 送出時寫進 take 的接續紀錄；first_frame 在 run 的取影格步驟完成後由 continuityTakeOutcome 補上。 */
export function takeContinuity(source: ContinuitySource): PreviousTakeContinuity {
  return {
    mode: "previous_last",
    source_shot_id: source.shot.shot_id,
    source_take_id: source.take.take_id,
    source_frame_index: source.frame.position === "index" ? source.frame.frame_index : null,
    first_frame: null,
  };
}

// ---------------------------------------------------------------- 素材庫圖片當首幀

/** 首幀圖片與專案畫面的比例容許差（相對）：H3 會把首幀拉伸到專案畫面，1% 以內看不出變形（Image Studio 的尺寸是 16 的倍數）。 */
export const FIRST_FRAME_RATIO_TOLERANCE = 0.01;

const KIND_NAMES: Record<StudioLibraryItem["kind"], string> = { image: t("圖片"), video: t("影片"), audio: t("聲音") };

type ImageFacts = Pick<StudioLibraryItem, "kind" | "width" | "height">;
type Format = StudioProject["format"];

function sameRatio(width: number, height: number, format: Format): boolean {
  return Math.abs((width * format.height) / (height * format.width) - 1) <= FIRST_FRAME_RATIO_TOLERANCE;
}

/**
 * 素材庫項目能不能當這個專案的首幀（Image Studio「用在影片鏡頭：當 fl2va 首幀」也用）：不是圖片、或比例與專案畫面不同
 * （會被拉伸變形）時回傳原因；可以時為 null。素材庫沒有記錄尺寸時無法確認，不擋下（firstFrameImageNote 說明）。
 */
export function firstFrameImageProblem(item: ImageFacts, format: Format): string | null {
  if (item.kind !== "image") return t("這個素材是{kind}：首幀只能用圖片", { kind: KIND_NAMES[item.kind] });
  const { width, height } = item;
  if (width === null || height === null || sameRatio(width, height, format)) return null;
  return t("圖片是 {width}×{height}，專案畫面是 {width2}×{height2}：比例不同，H3 會把首幀拉伸到專案畫面而變形。請用相同比例的圖片（例如在 Image Studio 以 {width3}×{height3} 生成），或在專案設定改畫面格式", { width, height, width2: format.width, height2: format.height, width3: format.width, height3: format.height });
}

/** 可以當首幀、但要知道的事：尺寸未知（無法確認比例）或同比例但尺寸不同（H3 會縮放）；尺寸相同或不能用時為 null。 */
export function firstFrameImageNote(item: ImageFacts, format: Format): string | null {
  if (item.kind !== "image") return null;
  const { width, height } = item;
  if (width === null || height === null) return t("素材庫沒有記錄這張圖片的尺寸，無法確認比例：比例與專案畫面（{width}×{height}）不同時，H3 會把首幀拉伸變形", { width: format.width, height: format.height });
  if (!sameRatio(width, height, format)) return null;
  if (width === format.width && height === format.height) return null;
  return t("圖片 {width}×{height} 與專案畫面同比例，H3 會縮放成 {width2}×{height2}", { width, height, width2: format.width, height2: format.height });
}

export interface ImageFirstFrame {
  item: StudioLibraryItem;
  /** 可以用但要知道的事（尺寸未知、會縮放）；沒有時 null。 */
  note: string | null;
}

export type ImageFirstFrameResult = { source: ImageFirstFrame; problem: null } | { source: null; problem: string };

/** 鏡頭以素材庫圖片當首幀：找到項目並檢查（是圖片、比例與專案畫面相同）；不行時回傳原因。 */
export function imageFirstFrameSource(project: StudioProject, shot: StudioShot): ImageFirstFrameResult {
  const itemId = firstFrameItemId(shot);
  if (!(itemId != null && itemId !== "")) return { source: null, problem: t("這個鏡頭沒有選首幀圖片") };
  const item = (project.library ?? []).find((entry) => entry.item_id === itemId);
  if (!item) return { source: null, problem: t("首幀圖片已不在專案素材庫（可能已被移除）：重新選一張圖片") };
  const problem = firstFrameImageProblem(item, project.format);
  if (problem != null && problem !== "") return { source: null, problem };
  return { source: { item, note: firstFrameImageNote(item, project.format) }, problem: null };
}

/** 送出時寫進 take 的紀錄：實際送進首幀輸入的檔案（之後素材庫移除這個項目也看得到用了哪張圖）。 */
export function imageTakeContinuity(source: ImageFirstFrame): ImageTakeContinuity {
  return { mode: "image", item_id: source.item.item_id, first_frame: source.item.file };
}

/** 素材庫中可以選來當首幀的圖片（新到舊）；Image Studio 的遮罩不列出（它不是畫面）。 */
export function firstFrameCandidates(library: readonly StudioLibraryItem[]): StudioLibraryItem[] {
  return library.filter((item) => item.kind === "image" && !isImageStudioMask(item)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ---------------------------------------------------------------- take 與鏡頭設定的差異、從 run 讀回

function sameFile(a: FileRef, b: FileRef): boolean {
  return a.node_id === b.node_id && a.file_id === b.file_id;
}

/** continuityChange 的「首幀設定（模式）不同」標籤：畫面以這個常數比較，不比對文字（文字會翻譯）。 */
export const CONTINUITY_MODE_CHANGED = t("首幀設定");

/**
 * take 的首幀來源與鏡頭目前的首幀設定是否不同（簡短標籤，可併入「已變更：…」）；一致時為 null。
 * 例如前一個鏡頭換了 take 或改了出點、換了首幀圖片：這個 take 就不再對應目前的設定，需要重新渲染。
 */
export function continuityChange(take: StudioTake, shot: StudioShot, project: StudioProject): string | null {
  const used = take.continuity ?? null;
  const wanted = continuityMode(shot);
  if ((used?.mode ?? "none") !== wanted) return CONTINUITY_MODE_CHANGED;
  if (!used) return null;
  if (used.mode === "image") {
    if (used.item_id !== firstFrameItemId(shot)) return t("首幀圖片");
    const item = (project.library ?? []).find((entry) => entry.item_id === used.item_id);
    return item && !sameFile(item.file, used.first_frame) ? t("首幀圖片") : null;
  }
  const { source } = continuitySource(project, shot);
  if (source?.shot.shot_id !== used.source_shot_id) return t("前一個鏡頭");
  if (source.take.take_id !== used.source_take_id) return t("前一個鏡頭的 take");
  const index = source.frame.position === "index" ? source.frame.frame_index : null;
  if (index !== used.source_frame_index) return t("前一個鏡頭的出點");
  return null;
}

export type ContinuityTakeOutcome = TakeOutcome & { continuity?: TakeContinuity | null };

/** 分支中把影像接到 TE first_frame 的步驟（取影格步驟）；沒有時為 null。 */
function firstFrameStep(run: WireRun, stepIds: readonly string[]): string | null {
  const ids = new Set(stepIds);
  for (const step of run.request.pipeline.steps) {
    if (!ids.has(step.step_id)) continue;
    const binding = step.inputs["first_frame"];
    if (binding && "from_step" in binding && ids.has(binding.from_step)) return binding.from_step;
  }
  return null;
}

/**
 * takeOutcome＋首幀資訊（take 沒有首幀紀錄時與 takeOutcome 相同）。接續前一個鏡頭：實際使用的首幀 FileRef 是取影格步驟的輸出；
 * 素材庫圖片：送出時已記下檔案，原樣保留。錯誤與各步耗時由 takeOutcome 依分支的全部步驟（含取影格與參考編碼）讀回。
 * 可直接當 updateTake 的 patch。
 */
export function continuityTakeOutcome(run: WireRun, take: StudioTake): ContinuityTakeOutcome {
  const base = takeOutcome(run, take);
  const used = take.continuity;
  if (!used) return base;
  if (used.mode === "image") return { ...base, continuity: used };
  const frameId = firstFrameStep(run, branchStepIds(run, take.output_key));
  const frame = (frameId != null && frameId !== "") ? parseRunStep(frameId, run.steps[frameId]) : null;
  const image = frame?.outputs["image"];
  const firstFrame = frame?.state === "succeeded" && image ? typedFile(image) : null;
  return { ...base, continuity: { ...used, first_frame: firstFrame ?? used.first_frame } };
}
