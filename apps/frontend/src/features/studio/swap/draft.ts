// 換角精靈的草稿型別與初始值（純資料；狀態與非同步工作在 useSwapDraft）。
import type { FileRef } from "@/api/generated/contracts";
import { newLocalId } from "../references/ids";
import type { SwapAudioMode } from "./job";
import { DEFAULT_CROSSFADE_FRAMES, type PlannedSegment, type SegmentPlan } from "./planner";
import { SCENE_DEFAULTS, type SceneParameters } from "./probe";
import { t } from "@/i18n";

export const STEP_IDS = ["source", "characters", "cuts", "plan", "output"] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface DraftSource {
  key: string;
  name: string;
  file: FileRef;
  /** 瀏覽器讀到的資訊（未知＝null）；切鏡偵測的結果另外合併，以偵測為準。 */
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean | null;
}

export interface DraftUpload {
  name: string;
  state: "reading" | "uploading" | "failed";
  error: string | null;
}

export interface DraftImage {
  key: string;
  name: string;
  origin: { kind: "library"; file: FileRef } | { kind: "local"; file: File };
  /** 顯示用 URL（素材庫用 /api/media，本機檔案用 object URL）。 */
  previewUrl: string;
  width: number | null;
  height: number | null;
  check: "checking" | "transparent" | "opaque" | "failed";
  error: string | null;
  /** 白底副本（透明圖才有；建立專案時上傳）。 */
  matte: Blob | null;
  matteUrl: string | null;
}

export interface DraftCharacter {
  id: string;
  image: DraftImage | null;
  who: string;
  appearance: string;
  mustNot: string;
}

export interface CutEntry {
  id: string;
  seconds: number;
}

export interface SwapDraft {
  step: StepId;
  source: DraftSource | null;
  sourceUpload: DraftUpload | null;
  startSeconds: number;
  /** null＝到影片結尾。 */
  endSeconds: number | null;
  characters: DraftCharacter[];
  style: string;
  dialogueLanguage: string;
  /** 切鏡偵測的參數。 */
  scene: SceneParameters;
  /** 使用者明確選擇不偵測（固定分段，只用手動切鏡）；偵測失敗時不會自動當成沒有切鏡。 */
  skipDetection: boolean;
  /** 不採用的偵測切鏡（秒，取到毫秒的字串）。 */
  disabledCuts: string[];
  manualCuts: CutEntry[];
  /** 每段上限（幀）；null＝用運算路由 DiT 的實測上限（換路由時跟著變）。 */
  maxFrames: number | null;
  /**
   * 超過預設上限試跑：DiT 還沒有量測的換角上限時，使用者選擇用換角本身的上限（最多 4 個角色、最長的 H3 段落）試跑；
   * 跑完後可以在換角面板記成量測的上限（measure.ts）。DiT 已經有量測值時不使用。
   */
  trial: boolean;
  crossfade: number;
  /** 段尾凍結（推薦，新的換角預設開啟）：每段的參考影片只用到段尾後一點原片，之後凍結最後一格（planner DEFAULT_HOLD_TAIL）。 */
  holdTail: boolean;
  /**
   * 每段的備註與沒有出現的角色，key＝段落在原影片的範圍（segmentKey）。分段改變時，範圍沒變的段落保留設定，
   * 範圍變了的段落不沿用（不會把備註套到別的畫面上）。
   */
  notes: Record<string, string>;
  absent: Record<string, string[]>;
  title: string;
  titleEdited: boolean;
  routeId: string | null;
  format: string;
  audio: SwapAudioMode;
  autoExport: boolean;
  startRender: boolean;
  /** The new project's plugin items; null = the current project's selection when the project is created. */
  plugins: string[] | null;
}

export const cutKey = (seconds: number) => seconds.toFixed(3);

export function newCharacter(): DraftCharacter {
  return { id: newLocalId("char"), image: null, who: "", appearance: "", mustNot: "" };
}

export function initialDraft(): SwapDraft {
  return {
    step: "source",
    source: null,
    sourceUpload: null,
    startSeconds: 0,
    endSeconds: null,
    characters: [newCharacter()],
    style: "",
    dialogueLanguage: "",
    scene: SCENE_DEFAULTS,
    skipDetection: false,
    disabledCuts: [],
    manualCuts: [],
    maxFrames: null,
    trial: false,
    crossfade: DEFAULT_CROSSFADE_FRAMES,
    holdTail: true,
    notes: {},
    absent: {},
    title: "",
    titleEdited: false,
    routeId: null,
    format: "768x448",
    audio: "generated",
    autoExport: true,
    startRender: true,
    plugins: null,
  };
}

/** 段落設定（備註、沒有出現的角色）的 key：段落保留的畫面在原影片的範圍（幀）。 */
export function segmentKey(plan: Pick<SegmentPlan, "start_frame">, segment: Pick<PlannedSegment, "timeline_start" | "timeline_end">): string {
  return `${plan.start_frame + segment.timeline_start}-${plan.start_frame + segment.timeline_end}`;
}

/** 依目前的分段，把草稿的段落設定排成建立專案用的陣列與索引表（範圍對不上的設定不使用）。 */
export function segmentSettings(draft: Pick<SwapDraft, "notes" | "absent">, plan: SegmentPlan): { notes: string[]; absent: Record<number, string[]> } {
  const notes: string[] = [];
  const absent: Record<number, string[]> = {};
  plan.segments.forEach((segment, index) => {
    const key = segmentKey(plan, segment);
    notes.push(draft.notes[key] ?? "");
    const ids = draft.absent[key];
    if (ids && ids.length > 0) absent[index] = [...ids];
  });
  return { notes, absent };
}

/** 專案名稱的預設值：「換角：<影片名>」（去掉副檔名）。 */
export function defaultTitle(sourceName: string | undefined): string {
  const base = (sourceName ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return t("換角：{value}", { value: base || t("未命名影片") }).slice(0, 200);
}
