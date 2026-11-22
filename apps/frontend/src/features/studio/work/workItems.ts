// The project's one 工作 list (pure): every run made for this project, of every kind — shot renders (single, variations,
// batches) and sequence exports as the project tracks them (QueueItem, with their rich detail), plus what the project
// only knows from the Controller's run list: fixes (局部重製), masks, mix previews, seam previews, animatics, reference
// media, draft plans, 修正 menu runs, transcription and voice lines, and tool runs that name the project (lab and
// experiment tools). One row per run, newest first, what is running ahead of everything else. Studio work is
// everything but those tool runs (WorkItem.studio): the list shows it, the tools wait in a collapsed group.
import { AudioLines, Brush, Clapperboard, Download, Film, Layers, ListVideo, type LucideIcon, Mic, Music, PanelsTopLeft, ScanLine, Scissors, Shuffle, Sparkles, SquareDashed, Wrench } from "lucide-react";
import type { StudioWorkOrigin } from "@/api/generated/contracts";
import type { WireRun } from "@/api/types";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";
import { parseFixNote } from "../fix/tools";
import type { TakeState } from "../model/project";
import type { QueueItem, QueueKind } from "../model/renderQueue";

type OperationKind = StudioWorkOrigin["operation_kind"];

/** The filter groups of the kind menu. */
export type WorkKind = "render" | "export" | "fix" | "retake" | "mask" | "audio_mix" | "animatic" | "seam" | "reference" | "draft" | "transcribe" | "speech" | "check" | "tool";

export const WORK_KINDS: readonly WorkKind[] = ["render", "export", "fix", "retake", "mask", "audio_mix", "transcribe", "speech", "check", "animatic", "seam", "reference", "draft", "tool"];

export const WORK_KIND_LABEL: Record<WorkKind, () => string> = {
  render: () => t("渲染"),
  export: () => t("匯出"),
  fix: () => t("修正"),
  retake: () => t("局部重製"),
  mask: () => t("遮罩"),
  audio_mix: () => t("混音試聽"),
  transcribe: () => t("字幕轉錄"),
  speech: () => t("配音"),
  animatic: () => t("預演"),
  seam: () => t("接縫預覽"),
  reference: () => t("參考素材"),
  draft: () => t("批次草稿"),
  check: () => t("影片檢查"),
  tool: () => t("其他工具"),
};

const KIND_ICON: Record<WorkKind, LucideIcon> = {
  render: Film,
  export: Download,
  fix: Clapperboard,
  retake: Scissors,
  mask: SquareDashed,
  audio_mix: Music,
  transcribe: Mic,
  speech: AudioLines,
  animatic: PanelsTopLeft,
  seam: Layers,
  reference: Sparkles,
  draft: Brush,
  check: ScanLine,
  tool: Wrench,
};

const QUEUE_ICON: Record<QueueKind, LucideIcon> = { shot: Film, variations: Shuffle, batch: ListVideo, export: Download };

export interface WorkItem {
  runId: string;
  kind: WorkKind;
  /** The row's kind word (「渲染」「局部重製」「字幕轉錄」…). */
  kindLabel: string;
  icon: LucideIcon;
  title: string;
  createdAt: string;
  state: TakeState;
  /** A render or export the project tracks (its takes, its export record): the full render detail. */
  queue: QueueItem | null;
  /** The Controller's summary row (null while the list has not reached this run). */
  run: WireRun | null;
  /** Studio work (everything but the lab and experiment tool runs that only name the project). */
  studio: boolean;
}

const OPERATION_KIND: Record<OperationKind, WorkKind> = {
  render: "render",
  export: "export",
  retake: "retake",
  mask: "mask",
  audio_mix: "audio_mix",
  animatic: "animatic",
  seam: "seam",
  reference: "reference",
  draft: "draft",
  draft_branch: "draft",
};

export function noteOf(run: WireRun): Record<string, unknown> {
  const note = run.request.origin?.note;
  if (note === undefined || note.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(note);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runKind(run: WireRun): WorkKind {
  const operation = (run.studio_work ?? run.request.origin?.studio_work)?.operation_kind;
  if (operation !== undefined) return OPERATION_KIND[operation];
  if (parseFixNote(run.request.origin?.note)) return "fix";
  const note = noteOf(run);
  if (note["kind"] === "transcribe") return "transcribe";
  if (note["kind"] === "speech") return "speech";
  if (note["type"] === "studio.audio-mix.v1") return "audio_mix";
  // 「檢查影片」 names the take it checked: it is the shot's work, listed with the renders, not a lab tool
  if (typeof note["take_id"] === "string" && typeof note["shot_id"] === "string") return "check";
  return "tool";
}

/** A Controller run state as the list shows it (running = the rendering mark). */
export function runState(run: WireRun): TakeState {
  return run.state === "running" ? "rendering" : run.state;
}

/**
 * The run's own label without the project prefix the Studio puts on it: 「Studio: <project> · 」 on renders, and
 * 「<project>・」 (in the language the run was started in) on transcription, voice lines and the other tools.
 */
export function runTitle(run: WireRun, projectTitle: string): string {
  const label = run.request.label ?? run.request.pipeline.label;
  // The label prefixes the Studio writes on its runs: matched data, not interface text
  const prefixes = [`Studio: ${projectTitle}`, `Studio：${projectTitle}`, projectTitle]; // i18n-ignore
  for (const prefix of prefixes) {
    if (projectTitle === "" || !label.startsWith(prefix)) continue;
    const rest = label.slice(prefix.length);
    // Only a whole title followed by a separator: 「專案 A」 must not eat 「專案 AB・…」
    const separated = /^[\s・·:：|｜-]+/u.exec(rest);
    if (separated && rest.length > separated[0].length) return rest.slice(separated[0].length);
  }
  return label;
}

function fromQueue(item: QueueItem, run: WireRun | null): WorkItem {
  const kind: WorkKind = item.kind === "export" ? "export" : "render";
  const kindLabel = item.kind === "variations" ? t("變體") : item.kind === "batch" ? t("批次渲染") : WORK_KIND_LABEL[kind]();
  return { runId: item.runId, kind, kindLabel, icon: QUEUE_ICON[item.kind], title: item.title, createdAt: item.createdAt, state: item.state, queue: item, run, studio: true };
}

function fromRun(run: WireRun, projectTitle: string): WorkItem {
  const kind = runKind(run);
  return { runId: run.run_id, kind, kindLabel: WORK_KIND_LABEL[kind](), icon: KIND_ICON[kind], title: runTitle(run, projectTitle), createdAt: run.created_at, state: runState(run), queue: null, run, studio: kind !== "tool" };
}

/** Every run of the project, newest first with the running ones ahead (stable among themselves). */
export function workItems(queue: readonly QueueItem[], runs: readonly WireRun[], projectTitle: string): WorkItem[] {
  const byId = new Map(runs.map((run) => [run.run_id, run]));
  const items = queue.map((item) => fromQueue(item, byId.get(item.runId) ?? null));
  const known = new Set(items.map((item) => item.runId));
  for (const run of runs) if (!known.has(run.run_id)) items.push(fromRun(run, projectTitle));
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.sort((a, b) => Number(b.state === "rendering") - Number(a.state === "rendering"));
}

/**
 * How many of the project's own jobs run now: the number the work list's 「進行中」 tab shows, and the one the status
 * bar's 「工作」 and the Render tab's badge repeat. Other projects' runs and the lab tools that only name the project are
 * not counted.
 */
export function activeWorkCount(items: readonly WorkItem[]): number {
  return items.filter((item) => item.studio && item.state === "rendering").length;
}

export type WorkFilter = "all" | "active" | "done" | "failed";

/** 沒有成功的都在「未成功」（失敗、取消、中斷）：標籤不把取消說成失敗。 */
export function matchesFilter(filter: WorkFilter, item: WorkItem): boolean {
  if (filter === "active") return item.state === "rendering";
  if (filter === "done") return item.state === "succeeded";
  if (filter === "failed") return item.state !== "succeeded" && item.state !== "rendering";
  return true;
}
