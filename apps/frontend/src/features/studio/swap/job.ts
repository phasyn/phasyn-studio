// 換角工作的狀態全部存在專案文件裡（重新整理後可以接續）：
// - 工作設定（範圍、聲音、每段上限、交叉溶接、是否自動匯出）寫在「來源影片」素材的 note（StudioProject 沒有額外欄位，
//   素材 note 不在介面上編輯，契約上限 2000 字）；
// - 每一段就是一個鏡頭：參考素材（角色圖＋參考影片視窗）、prompt、裁切（in／out）、出場轉場、渲染 take；
// - 匯出是專案的 exports。
// 這裡都是純函式：建立專案文件、送出渲染後的 take、由專案推導進度與能不能自動匯出。
import type { ApiErrorBody, Asset, FileRef, StudioExport, StudioLibraryItem, StudioProject, StudioReference, StudioShot, StudioTake } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { newLocalId } from "../references/ids";
import { branchSuffix } from "../model/pipelines";
import { placedShotIds } from "../editor/model";
import { activeTake, newProject, newShot, RANDOM_SEED, shotStatus, type ShotStatus } from "../model/project";
import { heldWindowFrames, type SegmentJoin, type SegmentPlan } from "./planner";
import { formatCueTime, swapPrompt, type SwapCharacterText } from "./prompt";
import { t } from "@/i18n";

/** generated（預設）＝台詞與聲音照 prompt 生成；original＝原影片音軌（送給模型當 <Audio 1>，匯出也用它）。 */
export type SwapAudioMode = "original" | "generated";

/** 參考影片的原聲是否當聲音參考送出（prompt 寫 <Audio 1>）：只有選原影片音軌、而且確定有音軌時。 */
export function soundtrackSent(audio: SwapAudioMode, hasAudio: boolean | null | undefined): boolean {
  return audio === "original" && hasAudio === true;
}

/** 開啟換角專案時帶的網址參數（?swap=1）：一打開就顯示「一鍵換角」的工作畫面。 */
export const SWAP_URL_PARAM = "swap";

/** 建立完成後開啟新專案的網址：渲染工作區＋換角工作畫面。 */
export function swapProjectUrl(projectId: string): string {
  return `/studio/render?project=${encodeURIComponent(projectId)}&${SWAP_URL_PARAM}=1`;
}

/** 存在來源影片素材 note 的工作設定。 */
export interface SwapJob {
  v: 1;
  fps: number;
  /** 原影片範圍（幀，終點不含）；匯出時原音軌從 start_frame／fps 秒開始。 */
  start_frame: number;
  end_frame: number;
  max_frames: number;
  crossfade_frames: number;
  audio: SwapAudioMode;
  /** 全部段落完成後自動匯出一次；嘗試過（不論成敗）就改成 false，不會自動重送。 */
  auto_export: boolean;
  segments: number;
  mid_shot_joins: number;
  created_at: string;
}

// 寫在專案資料裡、之後用來辨認換角工作的固定標記：不翻譯（翻了舊專案或另一種語言建立的專案就認不出來）。
const JOB_PREFIX = "一鍵換角的來源影片（下一行是 Studio 使用的工作設定，請勿修改）"; // i18n-ignore
const JOB_TAG = "swap.v1 ";

export function jobNote(job: SwapJob): string {
  return `${JOB_PREFIX}\n${JOB_TAG}${JSON.stringify(job)}`;
}

const isInt = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;

export function parseJobNote(note: string | undefined): SwapJob | null {
  const line = note?.split("\n").find((item) => item.startsWith(JOB_TAG));
  if (!line) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(JOB_TAG.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const job = raw as Record<string, unknown>;
  if (job.v !== 1 || !isInt(job.fps, 1) || !isInt(job.start_frame) || !isInt(job.end_frame, 1) || !isInt(job.max_frames, 1) || !isInt(job.crossfade_frames)) return null;
  if (job.end_frame <= job.start_frame) return null;
  if (job.audio !== "original" && job.audio !== "generated") return null;
  return {
    v: 1,
    fps: job.fps,
    start_frame: job.start_frame,
    end_frame: job.end_frame,
    max_frames: job.max_frames,
    crossfade_frames: job.crossfade_frames,
    audio: job.audio,
    auto_export: job.auto_export === true,
    segments: isInt(job.segments) ? job.segments : 0,
    mid_shot_joins: isInt(job.mid_shot_joins) ? job.mid_shot_joins : 0,
    created_at: typeof job.created_at === "string" ? job.created_at : "",
  };
}

export interface SwapProjectInfo {
  job: SwapJob;
  /** 來源影片（素材庫項目；note 帶著工作設定）。 */
  source: StudioLibraryItem;
}

/** 這個專案是不是一鍵換角建立的；是的話回傳工作設定與來源影片。 */
export function findSwapJob(project: StudioProject): SwapProjectInfo | null {
  for (const item of project.library ?? []) {
    if (item.kind !== "video") continue;
    const job = parseJobNote(item.note);
    if (job) return { job, source: item };
  }
  return null;
}

/** 更新工作設定（例如自動匯出已嘗試）後的素材庫；給 setLibrary 用。 */
export function libraryWithJob(library: readonly StudioLibraryItem[], sourceItemId: string, patch: Partial<SwapJob>): StudioLibraryItem[] {
  return library.map((item) => {
    if (item.item_id !== sourceItemId) return item;
    const job = parseJobNote(item.note);
    return job ? { ...item, note: jobNote({ ...job, ...patch }) } : item;
  });
}

// ---------------------------------------------------------------------------------------------- 建立專案

export interface SwapImage {
  name: string;
  file: FileRef;
  width: number | null;
  height: number | null;
}

export interface SwapCharacterInput extends SwapCharacterText {
  id: string;
  /** 原圖（不修改）。 */
  original: SwapImage;
  /** 白底副本（透明圖才有）；模型用這張。 */
  matte: SwapImage | null;
}

export interface SwapSource {
  name: string;
  file: FileRef;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean | null;
}

export interface BuildSwapInput {
  title: string;
  width: number;
  height: number;
  routeId: string;
  source: SwapSource;
  characters: readonly SwapCharacterInput[];
  plan: SegmentPlan;
  /** 每段的備註（依段落序號；寫進 prompt 與鏡頭備註）。 */
  notes: readonly string[];
  /** 每段沒有出現的角色 id（依段落序號）。 */
  absent: Readonly<Record<number, readonly string[]>>;
  style: string;
  dialogueLanguage: string;
  audio: SwapAudioMode;
  autoExport: boolean;
  /** The project's plugin items (StudioProject.prompt_plugins); empty = none. */
  plugins: readonly string[];
  now?: string;
}

/** What a segment prompt is written from (the characters only need their texts and ids). */
export interface SegmentPromptsInput extends Pick<BuildSwapInput, "plan" | "notes" | "absent" | "style" | "dialogueLanguage"> {
  characters: readonly (SwapCharacterText & { id: string })[];
  hasAudio: boolean;
}

/** The prompt and length of every segment, as buildSwapProject writes them into the shots (and the wizard checks them). */
export function segmentPrompts(input: SegmentPromptsInput): { prompt: string; frames: number }[] {
  return input.plan.segments.map((segment, index) => {
    const absent = new Set(input.absent[index] ?? []);
    const prompt = swapPrompt({
      characters: input.characters.filter((character) => !absent.has(character.id)),
      frames: segment.frames,
      fps: input.plan.fps,
      windowCuts: segment.window_cuts,
      holdAt: heldWindowFrames(segment, input.plan.fps),
      note: input.notes[index] ?? "",
      style: input.style,
      dialogueLanguage: input.dialogueLanguage,
      hasAudio: input.hasAudio,
    });
    return { prompt, frames: segment.frames };
  });
}

/** 接縫的說明（計畫表與鏡頭備註）。 */
export function joinLabel(join: SegmentJoin | null): string {
  if (!join) return t("最後一段");
  if (join.kind === "cut") return t("切鏡處");
  return join.crossfade_frames > 0 ? t("鏡頭中間（可能看得到接縫，已交叉溶接 {crossfade_frames} 影格）", { crossfade_frames: join.crossfade_frames }) : t("鏡頭中間（可能看得到接縫，未交叉溶接）");
}

function rangeText(plan: Pick<SegmentPlan, "start_frame" | "fps">, from: number, to: number): string {
  return `${formatCueTime(plan.start_frame + from, plan.fps)}–${formatCueTime(plan.start_frame + to, plan.fps)}`;
}

/** 鏡頭名稱：「第 02 段・00:05.170–00:10.340」（原影片時間）。 */
export function segmentTitle(plan: SegmentPlan, index: number): string {
  const segment = plan.segments[index];
  const width = String(plan.segments.length).length < 2 ? 2 : String(plan.segments.length).length;
  return t("第 {index} 段・{value}", { index: String(index + 1).padStart(width, "0"), value: segment ? rangeText(plan, segment.timeline_start, segment.timeline_end) : "" });
}

function segmentNote(plan: SegmentPlan, index: number, note: string): string {
  const segment = plan.segments[index];
  if (!segment) return "";
  const lines = [
    t("一鍵換角・第 {index}／{segmentsCount} 段", { index: index + 1, segmentsCount: plan.segments.length }),
    t("原影片 {rangeText}（保留 {keep_out_frame} 影格）", { rangeText: rangeText(plan, segment.timeline_start, segment.timeline_end), keep_out_frame: segment.keep_out_frame - segment.keep_in_frame }),
    t("參考視窗 {ref_start}–{ref_end}：生成 {frames} 影格，保留第 {keep_in_frame}–{keep_out_frame} 影格", { ref_start: formatCueTime(Math.round(segment.ref_start * plan.fps), plan.fps), ref_end: formatCueTime(Math.round(segment.ref_end * plan.fps), plan.fps), frames: segment.frames, keep_in_frame: segment.keep_in_frame, keep_out_frame: segment.keep_out_frame }),
    ...(segment.hold ? [t("段尾凍結：參考視窗之後重複最後一格，補滿生成長度")] : []),
    t("接下一段：{join_out}", { join_out: joinLabel(segment.join_out) }),
  ];
  if (note.trim()) lines.push(t("備註：{note}", { note: note.trim() }));
  return lines.join("\n");
}

function characterNote(character: SwapCharacterInput, index: number): string {
  const parts = [t("一鍵換角・角色 {index}", { index: index + 1 }), t("取代：{who}", { who: character.who.trim() }), t("外觀：{appearance}", { appearance: character.appearance.trim() })];
  if (character.mustNot.trim()) parts.push(t("不應出現：{mustNot}", { mustNot: character.mustNot.trim() }));
  return parts.join("\n").slice(0, 2000);
}

/** 換角專案的初稿（revision 0；還沒有 take）。不改原圖，模型用白底副本（有的話）。 */
export function buildSwapProject(input: BuildSwapInput): StudioProject {
  const now = input.now ?? new Date().toISOString();
  const { plan } = input;
  const base = newProject(input.title, { width: input.width, height: input.height, frames: plan.max_frames, route: input.routeId });
  const job: SwapJob = {
    v: 1,
    fps: plan.fps,
    start_frame: plan.start_frame,
    end_frame: plan.end_frame,
    max_frames: plan.max_frames,
    crossfade_frames: plan.crossfade_frames,
    audio: input.audio,
    auto_export: input.autoExport,
    segments: plan.segments.length,
    mid_shot_joins: plan.mid_shot_joins,
    created_at: now,
  };
  const sourceItem: StudioLibraryItem = {
    item_id: newLocalId("lib"),
    kind: "video",
    name: input.source.name,
    file: input.source.file,
    created_at: now,
    duration_seconds: input.source.duration_seconds,
    width: input.source.width,
    height: input.source.height,
    has_audio: input.source.has_audio,
    note: jobNote(job),
  };
  const library: StudioLibraryItem[] = [sourceItem];
  /** 每個角色送給模型的圖（白底副本，沒有就是原圖）的素材 id。 */
  const modelItems = new Map<string, string>();
  input.characters.forEach((character, index) => {
    const original: StudioLibraryItem = {
      item_id: newLocalId("lib"),
      kind: "image",
      name: character.original.name,
      file: character.original.file,
      created_at: now,
      duration_seconds: null,
      width: character.original.width,
      height: character.original.height,
      has_audio: false,
      note: character.matte ? t("一鍵換角・角色 {index} 的原圖（未修改；模型使用白底副本）", { index: index + 1 }) : characterNote(character, index),
    };
    library.push(original);
    let used = original.item_id;
    if (character.matte) {
      const matte: StudioLibraryItem = {
        item_id: newLocalId("lib"),
        kind: "image",
        name: character.matte.name,
        file: character.matte.file,
        created_at: now,
        duration_seconds: null,
        width: character.matte.width,
        height: character.matte.height,
        has_audio: false,
        note: characterNote(character, index),
      };
      library.push(matte);
      used = matte.item_id;
    }
    modelItems.set(character.id, used);
  });

  const prompts = segmentPrompts({ ...input, hasAudio: soundtrackSent(input.audio, input.source.has_audio) });
  const shots: StudioShot[] = [];
  plan.segments.forEach((segment, index) => {
    const absent = new Set(input.absent[index] ?? []);
    const present = input.characters.filter((character) => !absent.has(character.id));
    const references: StudioReference[] = present.map((character, at) => ({
      ref_id: newLocalId("ref"),
      kind: "image",
      alias: `Image${at + 1}`,
      item_id: modelItems.get(character.id) ?? "",
      start_seconds: null,
      end_seconds: null,
    }));
    references.push({
      ref_id: newLocalId("ref"),
      kind: "video",
      alias: "Video1",
      item_id: sourceItem.item_id,
      start_seconds: segment.ref_start,
      end_seconds: segment.ref_end,
      // Generated sound: the video is a picture reference only, so the voices follow the prompt and the new characters
      use_embedded_audio: input.audio === "original" ? input.source.has_audio : false,
      ...(segment.hold ? { hold_last_frame: true } : {}),
    });
    const note = input.notes[index] ?? "";
    const prompt = prompts[index]?.prompt ?? "";
    const shot = newShot(
      { ...base, shots },
      {
        title: segmentTitle(plan, index),
        prompt,
        frames: segment.frames,
        seed: RANDOM_SEED,
        route: input.routeId,
        in_frame: segment.keep_in_frame,
        out_frame: segment.keep_out_frame >= segment.frames ? null : segment.keep_out_frame,
        ...(segment.transition_out.kind === "crossfade" ? { effects: { transition_out: { kind: "crossfade" as const, frames: segment.transition_out.frames } } } : {}),
        references,
        note: segmentNote(plan, index, note),
      },
    );
    shots.push(shot);
  });
  return { ...base, library, shots, ...(input.plugins.length > 0 ? { prompt_plugins: [...input.plugins] } : {}) };
}

// ---------------------------------------------------------------------------------------------- 進度

/**
 * done＝有可用的 take；stale＝有可用 take 但設定已改；cancelled／interrupted＝最近一次被取消或因 Controller 重新啟動而
 * 中斷（不是失敗）；skipped＝同一批次的其他段落失敗，這段沒有執行。
 */
export type SegmentState = "pending" | "rendering" | "done" | "stale" | "failed" | "cancelled" | "interrupted" | "skipped";

export interface SegmentView {
  shot: StudioShot;
  index: number;
  status: ShotStatus;
  state: SegmentState;
  latest: StudioTake | null;
  error: ApiErrorBody | null;
}

export type SwapPhase = "pending" | "rendering" | "failed" | "ready_to_export" | "exporting" | "exported" | "export_failed";

export interface SwapProgress {
  segments: SegmentView[];
  counts: Record<SegmentState, number>;
  /** 有可用 take 的段落數（done＋stale）。 */
  playable: number;
  /** 渲染中的 run（每個 run 一次）。 */
  activeRunIds: string[];
  /** 還沒有可用 take、也沒有在渲染的段落（「繼續渲染」的對象）。 */
  remaining: string[];
  latestExport: StudioExport | null;
  /** 最新的匯出成功（原音軌模式還要確認真的用了原音軌），且之後沒有段落換過 take。 */
  exportCurrent: boolean;
  /** 最新的匯出「成功」但不能算數的原因（例如 concat 沒有改用原音軌）。 */
  exportProblem: string | null;
  phase: SwapPhase;
}

/** 這個 take 的 run 失敗在別的段落（批次 run 第一個失敗後其餘步驟不執行）。 */
export function failedInOtherSegment(take: StudioTake): boolean {
  const stepId = take.error?.details?.step_id;
  const suffix = branchSuffix(take.output_key);
  return typeof stepId === "string" && suffix !== "" && !stepId.endsWith(suffix);
}

function segmentState(status: ShotStatus, latest: StudioTake | null): SegmentState {
  if (status === "rendering") return "rendering";
  if (status === "ready") return "done";
  if (status === "stale") return "stale";
  if (status === "cancelled" || status === "interrupted") return status;
  if (!latest) return "pending";
  return failedInOtherSegment(latest) ? "skipped" : "failed";
}

/** 結束了卻沒有可用 take 的段落數：失敗、取消、中斷，以及因別段失敗而沒有執行的。 */
export function unfinishedSegments(counts: Record<SegmentState, number>): number {
  return counts.failed + counts.cancelled + counts.interrupted + counts.skipped;
}

/** 原音軌模式的匯出沒有讀到來源影片的聲音時的錯誤（匯出後核對，不推測原因）。 */
export const AUDIO_TRACK_MISSING = t("匯出結果沒有使用原影片音軌");

/**
 * 匯出結果有沒有用到來源影片的聲音：時間軸匯出把讀到的來源記在 actual_settings.concat.sources（原音軌是時間軸上的一個
 * 音訊片段）；較早的匯出記在 actual_settings.concat.audio_track。true＝有紀錄；false＝有 concat 紀錄但沒有用到；
 * null＝沒有 concat 紀錄。
 */
export function originalAudioApplied(asset: Asset | null | undefined, source: Pick<StudioLibraryItem, "file">): boolean | null {
  const concat = asset?.actual_settings.concat;
  if (!isRecord(concat)) return null;
  if (concat.timeline === true) {
    const sources: unknown[] = Array.isArray(concat.sources) ? concat.sources : [];
    return sources.some((item) => isRecord(item) && item.file_id === source.file.file_id);
  }
  const record = concat.audio_track;
  return record !== undefined && record !== null && record !== false;
}

/** info 有給時，原音軌模式的匯出要確實讀了來源影片的聲音才算成功。 */
export function swapProgress(project: StudioProject, info?: Pick<SwapProjectInfo, "job" | "source">): SwapProgress {
  const counts: Record<SegmentState, number> = { pending: 0, rendering: 0, done: 0, stale: 0, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 };
  const runIds = new Set<string>();
  // 段落＝成片裡的鏡頭（生成的單位）：時間軸上有片段的鏡頭；專案還沒有時間軸（剛建立、尚未保存）時就是全部鏡頭
  const placed = project.timeline ? placedShotIds(project.timeline) : null;
  const segments = project.shots
    .filter((shot) => !placed || placed.has(shot.shot_id))
    .map((shot, index): SegmentView => {
      const latest = shot.takes.at(-1) ?? null;
      const status = shotStatus(shot, project);
      const state = segmentState(status, latest);
      counts[state] += 1;
      for (const take of shot.takes) if (take.state === "rendering") runIds.add(take.run_id);
      return { shot, index, status, state, latest, error: state === "done" || state === "stale" ? null : (latest?.error ?? null) };
    });
  const playable = counts.done + counts.stale;
  const remaining = segments.filter((segment) => !["done", "stale", "rendering"].includes(segment.state)).map((segment) => segment.shot.shot_id);
  const latestExport = [...project.exports].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1) ?? null;
  const takenAt = segments.map((segment) => activeTake(segment.shot)?.created_at ?? "");
  const shotIds = new Set(segments.map((segment) => segment.shot.shot_id));
  // 段落在成片裡的先後由時間軸決定，所以只比對「同一組段落」
  const sameShots = (record: StudioExport) => record.shot_ids.length === shotIds.size && record.shot_ids.every((id) => shotIds.has(id));
  const original = info?.job.audio === "original";
  const exportProblem = latestExport?.state === "succeeded" && original && originalAudioApplied(latestExport.asset, info.source) !== true ? AUDIO_TRACK_MISSING : null;
  const exportCurrent = Boolean(
    latestExport && latestExport.state === "succeeded" && latestExport.asset && !exportProblem && sameShots(latestExport) && takenAt.every((at) => at !== "" && at <= latestExport.created_at),
  );
  const allPlayable = segments.length > 0 && playable === segments.length;
  let phase: SwapPhase;
  if (counts.rendering > 0) phase = "rendering";
  else if (!allPlayable) phase = unfinishedSegments(counts) > 0 ? "failed" : "pending";
  else if (latestExport?.state === "rendering") phase = "exporting";
  else if (exportCurrent) phase = "exported";
  else if (latestExport && (latestExport.state !== "succeeded" || exportProblem) && takenAt.every((at) => at <= latestExport.created_at)) phase = "export_failed";
  else phase = "ready_to_export";
  return { segments, counts, playable, activeRunIds: [...runIds], remaining, latestExport, exportCurrent, exportProblem, phase };
}

/** 全部段落完成後自動匯出一次：工作設定要求、從來沒有匯出過、全部段落都有可用 take、沒有段落在渲染。 */
export function shouldAutoExport(project: StudioProject, info: SwapProjectInfo, progress: SwapProgress): boolean {
  return info.job.auto_export && project.exports.length === 0 && progress.phase === "ready_to_export";
}
