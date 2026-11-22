// The 修正 (Fix) menu's tools: one place to fix a take. Each tool has a creator-facing Chinese name and a one-line
// description; the pipeline ids it runs stay behind a tooltip and the dialog's 進階 section. A tool either opens an
// existing editor flow (局部重製, 遮罩, 草稿精修) or runs one saved pipeline with the take as its input; the result
// comes back where the owner started: a new take of the same shot (「修正自 take N · 工具」), the project library
// (control materials), or files shown in the dialog (packages, subtitles, comparison frames).
import { Activity, Clapperboard, Columns2, Contrast, Eraser, FastForward, FileDown, FileUp, Focus, Layers, type LucideIcon, Maximize2, Mic, Move, PenTool, Rewind, Scissors, ScanLine, Sparkles, Subtitles, Wand2 } from "lucide-react";
import type { StudioLibraryItem, StudioShot, StudioTake } from "@/api/generated/contracts";
import type { WirePipeline, WireTypedValue } from "@/api/types";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { takeNumber } from "../model/takeDownload";

export type FixGroupId = "local" | "quality" | "motion" | "control" | "sound" | "art" | "compare";

/** What happens with a finished run. */
export type FixResult = "take" | "library" | "files";

export type FixFlow = "retake" | "mask" | "drafts";

interface FixToolBase {
  id: string;
  group: FixGroupId;
  icon: LucideIcon;
  name: () => string;
  description: () => string;
}

export interface FlowTool extends FixToolBase {
  kind: "flow";
  flow: FixFlow;
}

export interface PipelineTool extends FixToolBase {
  kind: "pipeline";
  /** Saved pipelines that do this, in order of preference (the first one the Controller has is used). */
  pipelines: readonly string[];
  /** The input port that receives the take. */
  input: string;
  /** The output that becomes the result (a take or a library item). */
  output: string;
  result: FixResult;
  /** Inputs shown in the main part of the dialog (the rest of the optional ones wait under 進階). */
  shown?: readonly string[];
  /** A second take of the same shot is asked for (比較). */
  pairInput?: string;
  /**
   * Parameters this tool sets on the step that produces its output, whatever the saved pipeline says: what makes the
   * result a usable take (延展 delivers the original and the extension as one take; 換上定稿聲軌 converts any chosen
   * audio to what the mux needs).
   */
  parameters?: Readonly<Record<string, string | number | boolean>>;
  /**
   * The step that works at the source's own short side (畫質修復 restores at the take's resolution instead of the
   * saved pipeline's fixed size); a source of unknown size keeps the saved value.
   */
  nativeShortSide?: string;
}

export type FixTool = FlowTool | PipelineTool;

export const FIX_GROUPS: readonly { id: FixGroupId; label: () => string }[] = [
  { id: "local", label: () => t("局部修改") },
  { id: "quality", label: () => t("修復畫質") },
  { id: "motion", label: () => t("動作與補幀") },
  { id: "control", label: () => t("遮罩與控制") },
  { id: "sound", label: () => t("聲音與字幕") },
  { id: "art", label: () => t("美術往返") },
  { id: "compare", label: () => t("比較") },
];

export const FIX_TOOLS: readonly FixTool[] = [
  { id: "retake", kind: "flow", flow: "retake", group: "local", icon: Scissors, name: () => t("局部重製"), description: () => t("選一段影格重新生成，保留原音") },
  { id: "mask", kind: "flow", flow: "mask", group: "local", icon: Eraser, name: () => t("遮罩"), description: () => t("點選人物或物件，做出逐幀遮罩給局部重製用") },
  { id: "drafts", kind: "flow", flow: "drafts", group: "local", icon: Wand2, name: () => t("批次草稿與精修"), description: () => t("先批次出草稿，挑一個候選建立精修分支") },
  {
    id: "restore", kind: "pipeline", group: "quality", icon: Sparkles, name: () => t("畫質修復"), description: () => t("SeedVR2 以原解析度整段修復模糊與雜訊"),
    pipelines: ["restore-take-local"], input: "video", output: "final", result: "take", nativeShortSide: "restore",
  },
  {
    id: "upscale", kind: "pipeline", group: "quality", icon: Maximize2, name: () => t("超分 2×"), description: () => t("Anime4K 放大兩倍，保留幀數與聲音"),
    pipelines: ["upscale-take-2x"], input: "video", output: "final", result: "take",
  },
  {
    id: "finish", kind: "pipeline", group: "quality", icon: Focus, name: () => t("修復並補幀"), description: () => t("以原解析度一次完成畫質修復、補幀與首尾影格檢查"),
    pipelines: ["finish-take-local"], input: "video", output: "final", result: "take", nativeShortSide: "restore",
  },
  {
    id: "interpolate", kind: "pipeline", group: "motion", icon: Activity, name: () => t("補幀 2×"), description: () => t("RIFE 讓動作更順，長度與聲音不變"),
    pipelines: ["interpolate-take-local"], input: "video", output: "final", result: "take",
  },
  {
    id: "extend-after", kind: "pipeline", group: "motion", icon: FastForward, name: () => t("向後延展"), description: () => t("依描述把鏡頭往後接長，原片與延展合成一個新 take"),
    pipelines: ["wan-edit-extend-after"], input: "source", output: "final", result: "take", shown: ["prompt"], parameters: { deliver: "joined" },
  },
  {
    id: "extend-before", kind: "pipeline", group: "motion", icon: Rewind, name: () => t("向前延展"), description: () => t("依描述在鏡頭前面補一段，原片與延展合成一個新 take"),
    pipelines: ["wan-edit-extend-before"], input: "source", output: "final", result: "take", shown: ["prompt"], parameters: { deliver: "joined" },
  },
  {
    id: "depth", kind: "pipeline", group: "control", icon: Layers, name: () => t("深度圖"), description: () => t("產生逐格深度影片，加入素材庫"),
    pipelines: ["depth-control-local"], input: "video_file", output: "asset", result: "library",
  },
  {
    id: "pose", kind: "pipeline", group: "control", icon: Move, name: () => t("姿勢骨架"), description: () => t("擷取人體姿勢影片，加入素材庫"),
    pipelines: ["pose-control-local"], input: "video_file", output: "asset", result: "library",
  },
  {
    id: "edge", kind: "pipeline", group: "control", icon: PenTool, name: () => t("輪廓線稿"), description: () => t("產生逐格輪廓影片，加入素材庫"),
    pipelines: ["prepare-control-and-review-local"], input: "video", output: "control", result: "library",
  },
  {
    id: "person-mask", kind: "pipeline", group: "control", icon: Contrast, name: () => t("人物遮罩"), description: () => t("自動找出單一人物，產生遮罩影片"),
    pipelines: ["person-mask-local"], input: "video_file", output: "asset", result: "library",
  },
  {
    id: "soundtrack", kind: "pipeline", group: "sound", icon: Mic, name: () => t("換上定稿聲軌"), description: () => t("用選好的音檔取代這個 take 的聲音"),
    pipelines: ["soundtrack-take-local"], input: "video", output: "final", result: "take", shown: ["soundtrack"], parameters: { audio_fit: "conform" },
  },
  {
    id: "transcribe", kind: "pipeline", group: "sound", icon: Subtitles, name: () => t("辨識字幕"), description: () => t("辨識對白，產生字幕檔"),
    pipelines: ["transcribe-local"], input: "video_file", output: "srt_file", result: "files",
  },
  {
    id: "art-export", kind: "pipeline", group: "art", icon: FileDown, name: () => t("在 Krita 修稿"), description: () => t("匯出美術工作包（ZIP），在 Krita 等軟體修改"),
    pipelines: ["art-export"], input: "video_file", output: "delivery_file", result: "files",
  },
  {
    id: "art-return", kind: "pipeline", group: "art", icon: FileUp, name: () => t("匯回修改稿"), description: () => t("把改好的影片或圖片匯回來，加入素材庫"),
    pipelines: ["art-return"], input: "", output: "delivery_file", result: "library", shown: ["video_file", "image_file"],
  },
  {
    id: "compare", kind: "pipeline", group: "compare", icon: Columns2, name: () => t("比較兩個 take"), description: () => t("並排看兩個 take 的首尾影格"),
    pipelines: ["compare-takes-local"], input: "take_a", output: "a_first", result: "files", pairInput: "take_b",
  },
];

/** Icons other parts of the fix UI use. */
export const FIX_ICON = Clapperboard;
export const REVIEW_ICON = ScanLine;

export function fixTool(id: string): FixTool | null {
  return FIX_TOOLS.find((tool) => tool.id === id) ?? null;
}

/** The pipeline as this tool runs it on this source: its parameters set on the step that produces the tool's output. */
export function toolPipeline(tool: PipelineTool, pipeline: WirePipeline, source?: FixSource): WirePipeline {
  const parameters = tool.parameters;
  const producer = pipeline.outputs[tool.output]?.from_step;
  const shortSide = tool.nativeShortSide !== undefined && source ? sourceShortSide(source) : null;
  if ((!parameters || producer === undefined) && shortSide === null) return pipeline;
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => {
      let next = step;
      if (parameters && step.step_id === producer) next = { ...next, parameters: { ...next.parameters, ...parameters } };
      if (shortSide !== null && step.step_id === tool.nativeShortSide) next = { ...next, parameters: { ...next.parameters, short_side: shortSide } };
      return next;
    }),
  };
}

/** The restorer's accepted short sides: even, within these bounds. */
const SHORT_SIDE_MIN = 128;
const SHORT_SIDE_MAX = 1536;

/** The source's short side in pixels as the restorer takes it (even, within its bounds); null when the size is unknown. */
export function sourceShortSide(source: FixSource): number | null {
  return source.kind === "take"
    ? restoreShortSide(source.take.asset?.width ?? null, source.take.asset?.height ?? null)
    : restoreShortSide(source.item.width, source.item.height);
}

/** The short side of a picture of this size as the restorer takes it; null when the size is unknown. */
export function restoreShortSide(width: number | null, height: number | null): number | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  const short = Math.min(width, height);
  return Math.min(SHORT_SIDE_MAX, Math.max(SHORT_SIDE_MIN, short - (short % 2)));
}

export function toolForPipeline(pipelineId: string): PipelineTool | null {
  for (const tool of FIX_TOOLS) if (tool.kind === "pipeline" && tool.pipelines.includes(pipelineId)) return tool;
  return null;
}

/** What a fix works on: a take of a shot (Shot and Edit pages) or a video of the project library. */
export type FixSource =
  | { kind: "take"; shot: StudioShot; take: StudioTake }
  | { kind: "library"; item: StudioLibraryItem };

/**
 * The origin note of a fix run: it names the project (so project run lists include it), the shot, the take and the
 * tool; a fix of a library item has empty shot and take ids and names the item instead.
 */
export interface FixNote {
  project_id: string;
  shot_id: string;
  take_id: string;
  fix: string;
  item_id?: string;
}

export function fixNote(note: FixNote): string {
  return JSON.stringify({
    project_id: note.project_id, shot_id: note.shot_id, take_id: note.take_id, fix: note.fix,
    ...(note.item_id !== undefined ? { item_id: note.item_id } : {}),
  });
}

/** The note of a fix started on this source. */
export function sourceNote(projectId: string, source: FixSource, fix: string): string {
  return source.kind === "take"
    ? fixNote({ project_id: projectId, shot_id: source.shot.shot_id, take_id: source.take.take_id, fix })
    : fixNote({ project_id: projectId, shot_id: "", take_id: "", item_id: source.item.item_id, fix });
}

/** The fix run was started on this source. */
export function noteMatches(note: FixNote, source: FixSource): boolean {
  return source.kind === "take" ? note.take_id === source.take.take_id : note.item_id === source.item.item_id;
}

/** The source as the value of a pipeline input (a library item has a file only, no recorded asset). */
export function sourceValue(source: FixSource, typeId: string): WireTypedValue | null {
  if (source.kind === "take") return takeValue(source.take, typeId);
  return typeId === `media.${source.item.kind}.v1` ? { type_id: typeId, file: source.item.file } : null;
}

export function parseFixNote(note: string | null | undefined): FixNote | null {
  if (note?.startsWith("{") !== true) return null;
  try {
    const value: unknown = JSON.parse(note);
    if (!isRecord(value)) return null;
    const { project_id: project, shot_id: shot, take_id: take, fix, item_id: item } = value;
    if (typeof project !== "string" || typeof shot !== "string" || typeof take !== "string" || typeof fix !== "string") return null;
    return typeof item === "string" ? { project_id: project, shot_id: shot, take_id: take, fix, item_id: item } : { project_id: project, shot_id: shot, take_id: take, fix };
  } catch {
    return null;
  }
}

/** 「修正自 take 2 · 畫質修復」 */
export function fixLabel(parentNumber: number | null, toolName: string): string {
  return parentNumber === null ? t("修正 · {tool}", { tool: toolName }) : t("修正自 take {number} · {tool}", { number: parentNumber, tool: toolName });
}

/** The name of a fix of this source: 「修正自 take 2 · 畫質修復」, or 「素材名稱 · 畫質修復」 for a library item. */
export function sourceFixLabel(source: FixSource, toolName: string): string {
  return source.kind === "take" ? fixLabel(takeNumber(source.shot, source.take), toolName) : t("{name} · {tool}", { name: source.item.name, tool: toolName });
}

/** A take that a fix made: the take it came from (when it is still on the shot) and the tool's name. */
export function fixOrigin(shot: StudioShot, take: StudioTake): { parentNumber: number | null; label: string } | null {
  const adoption = take.media_adoption;
  if (!adoption) return null;
  const tool = toolForPipeline(take.route);
  const parentId = adoption.parent_take_id ?? null;
  if (!tool && parentId === null) return null;
  const parent = parentId === null ? undefined : shot.takes.find((item) => item.take_id === parentId);
  const parentNumber = parent ? takeNumber(shot, parent) : null;
  return { parentNumber, label: fixLabel(parentNumber, tool ? tool.name() : t("修正")) };
}

/** The take as the value of a pipeline input: its video file, or the whole recorded asset for an asset port. */
export function takeValue(take: StudioTake, typeId: string): WireTypedValue | null {
  const asset = take.asset;
  if (asset?.complete !== true) return null;
  if (typeId === "media.asset.v1") return { type_id: typeId, value: asset };
  if (typeId === "media.video.v1") return { type_id: typeId, file: asset.file };
  return null;
}
