// LoRA 訓練工作的檢視模型：把主控的工作文件（巢狀部分是寬鬆的 JSON）讀成畫面需要的窄型別，並集中所有文字。
import type { FileRef, LoraTraining, LoraTrainingSummary } from "@/api/generated/contracts";
import type { StepperStep, StepState } from "@/components/workbench/Stepper";
import type { Tone } from "@/components/workbench/tones";
import { isFileRef } from "@/api/types";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";

export type TrainingStatus = LoraTraining["status"];
export type TrainingPhase = LoraTraining["phase"];
export type SourceRole = "train" | "heldout" | "eval_only";

export const ROLE_LABEL: Record<SourceRole, string> = {
  train: t("訓練"),
  heldout: t("留出（只比較）"),
  eval_only: t("只比較，不訓練"),
};
export const ROLE_HINT: Record<SourceRole, string> = {
  train: t("這支影片的片段會用來訓練"),
  heldout: t("同類型但不訓練的影片：拿來比較 LoRA 有沒有幫助（避免只記住訓練資料）"),
  eval_only: t("只拿來當比較的參考，例如 AI 生成或二創影片：絕不訓練，以免學到「AI 味」"),
};

export const STATUS_SPEC: Record<TrainingStatus, { label: string; tone: Tone; spinning: boolean }> = {
  running: { label: t("進行中"), tone: "info", spinning: true },
  stopping: { label: t("正在停止"), tone: "warning", spinning: true },
  review: { label: t("等你決定"), tone: "action", spinning: false },
  paused: { label: t("已暫停"), tone: "warning", spinning: false },
  completed: { label: t("已完成"), tone: "success", spinning: false },
  failed: { label: t("失敗"), tone: "danger", spinning: false },
  cancelled: { label: t("已取消"), tone: "neutral", spinning: false },
};

const PHASES: readonly { id: string; label: string; phases: readonly TrainingPhase[] }[] = [
  { id: "clips", label: t("切片段"), phases: ["clips"] },
  { id: "review", label: t("自動反推"), phases: ["review"] },
  { id: "select", label: t("挑選資料"), phases: ["select"] },
  { id: "encode", label: t("編碼"), phases: ["encode"] },
  { id: "train", label: t("訓練"), phases: ["train"] },
  { id: "compare", label: t("強度比較"), phases: ["compare"] },
  { id: "decide", label: t("決定"), phases: ["decide", "register", "registered", "discarded"] },
];

export const PHASE_LABEL: Record<TrainingPhase, string> = {
  clips: t("切片段"),
  review: t("自動反推"),
  select: t("挑選資料"),
  encode: t("編碼"),
  train: t("訓練"),
  compare: t("強度比較"),
  decide: t("決定"),
  register: t("登錄 LoRA"),
  registered: t("已登錄"),
  discarded: t("已捨棄"),
};

/** 七個階段的 Stepper（目前階段依狀態顯示進行中、暫停或錯誤）。 */
export function phaseSteps(job: Pick<LoraTraining, "phase" | "status">, detail: string | null): StepperStep[] {
  const index = PHASES.findIndex((p) => p.phases.includes(job.phase));
  return PHASES.map((p, i) => {
    let state: StepState = i < index ? "done" : i === index ? "active" : "pending";
    if (i === index && job.status === "failed") state = "error";
    if (i === index && job.status === "cancelled") state = "cancelled";
    if (i === index && job.status === "paused") state = "interrupted";
    if (i === index && job.status === "completed") state = "done";
    return { id: p.id, label: p.label, state, ...(i === index && detail !== null ? { detail } : {}) };
  });
}

export const REJECT_LABEL: Record<string, string> = {
  technical: t("技術條件不符（黑邊、跳切或格數不足）"),
  dropped_by_user: t("你移除的"),
  no_review: t("沒有反推結果"),
  review: t("不是手繪 2D 或有大字"),
  identity: t("caption 含身分資訊"),
  soft: t("畫面偏糊（同來源最糊的四分之一）"),
  duplicate: t("和其他片段重複"),
  leak: t("和留出影片太像（避免洩漏）"),
  source_cap: t("同一來源太多"),
  logo: t("有浮水印或角標，但找不到位置遮掉"),
};

/** Overlays masked out of a clip's loss (and blanked in its reference stills), by mask reason. */
export const MASK_LABEL: Record<string, string> = {
  static_overlay: t("已遮浮水印／角標"),
  subtitles: t("已遮字幕"),
};

export function rejectLabel(reason: string | null | undefined): string {
  if (reason == null) return "";
  return REJECT_LABEL[reason.split(":")[0] ?? ""] ?? reason;
}

export interface ClipRow {
  clip_id: string;
  source_id: string;
  role: SourceRole;
  status: "train" | "heldout" | "rejected";
  reason: string | null;
  caption: string | null;
  sheet: FileRef | null;
  start_seconds: number | null;
  masks: string[];
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fileRef(v: unknown): FileRef | null {
  return isFileRef(v) ? v : null;
}

const ROLES: readonly SourceRole[] = ["train", "heldout", "eval_only"];
const CLIP_STATUSES: readonly ClipRow["status"][] = ["train", "heldout", "rejected"];

export function asRole(v: unknown): SourceRole {
  return ROLES.find((r) => r === v) ?? "train";
}

function asClipStatus(v: unknown): ClipRow["status"] {
  return CLIP_STATUSES.find((s) => s === v) ?? "rejected";
}

export function clipRows(job: LoraTraining): ClipRow[] {
  const rows: unknown[] = Array.isArray(job.clips) ? job.clips : [];
  return rows.filter(isRecord).map((r) => ({
    clip_id: str(r["clip_id"]) ?? "",
    source_id: str(r["source_id"]) ?? "",
    role: asRole(r["role"]),
    status: asClipStatus(r["status"]),
    reason: str(r["reason"]),
    caption: str(r["caption"]),
    sheet: fileRef(r["sheet"]),
    start_seconds: num(r["start_seconds"]),
    masks: Array.isArray(r["masks"]) ? r["masks"].filter((m): m is string => typeof m === "string") : [],
  }));
}

export interface SourceInfo {
  source_id: string;
  label: string;
  role: SourceRole;
}

export function sources(job: LoraTraining): SourceInfo[] {
  return job.sources.filter(isRecord).map((s) => ({
    source_id: str(s["source_id"]) ?? "",
    label: str(s["label"]) ?? "",
    role: asRole(s["role"]),
  }));
}

export interface TrainingView {
  steps: number;
  done: number;
  loss: { step: number; loss: number }[];
  loras: number[];
  autoResumes: number;
  stopRequested: boolean;
  parameters: Record<string, unknown>;
}

export function trainingView(job: LoraTraining): TrainingView | null {
  const tr = job.training;
  if (!isRecord(tr)) return null;
  const loss = Array.isArray(tr["loss_curve"]) ? (tr["loss_curve"] as unknown[]).filter(isRecord) : [];
  return {
    steps: num(tr["steps"]) ?? 0,
    done: num(tr["done_step"]) ?? 0,
    loss: loss.map((p) => ({ step: num(p["step"]) ?? 0, loss: num(p["loss"]) ?? 0 })),
    loras: isRecord(tr["loras"]) ? Object.keys(tr["loras"]).map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [],
    autoResumes: num(tr["auto_resumes"]) ?? 0,
    stopRequested: tr["stop_requested"] === true,
    parameters: isRecord(tr["parameters"]) ? tr["parameters"] : {},
  };
}

export interface EvalItem {
  eval_id: string;
  kind: "heldout" | "custom";
  prompt: string;
  sheet: FileRef | null;
}

export function evalItems(job: LoraTraining): EvalItem[] {
  return job.eval_items?.filter(isRecord).map((e) => ({
    eval_id: str(e["eval_id"]) ?? "",
    kind: str(e["kind"]) === "custom" ? "custom" : "heldout",
    prompt: str(e["prompt"]) ?? "",
    sheet: fileRef(e["sheet"]),
  })) ?? [];
}

export interface Cell {
  strength: number;
  state: string;
  runId: string | null;
  assets: (FileRef | null)[];
}

export interface RouteView {
  route_id: string;
  label: string;
  status: string;
  error: string | null;
  cells: Cell[];
}

export interface RoundView {
  step: number;
  final: boolean;
  status: string;
  routes: RouteView[];
}

function assetFile(v: unknown): FileRef | null {
  return isRecord(v) ? fileRef(v["file"]) : null;
}

export function rounds(job: LoraTraining): RoundView[] {
  const raw = isRecord(job.comparison) && Array.isArray(job.comparison["rounds"]) ? (job.comparison["rounds"] as unknown[]) : [];
  return raw.filter(isRecord).map((r) => ({
    step: num(r["step"]) ?? 0,
    final: r["final"] === true,
    status: str(r["status"]) ?? "",
    routes: (Array.isArray(r["routes"]) ? (r["routes"] as unknown[]) : []).filter(isRecord).map((route) => ({
      route_id: str(route["route_id"]) ?? "",
      label: str(route["label"]) ?? "",
      status: str(route["status"]) ?? "",
      error: str(route["error"]),
      cells: Object.entries(isRecord(route["cells"]) ? route["cells"] : {})
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .map(([strength, cell]) => ({
          strength: Number(strength),
          state: str(cell["state"]) ?? "pending",
          runId: str(cell["run_id"]),
          assets: Array.isArray(cell["assets"]) ? (cell["assets"] as unknown[]).map(assetFile) : [],
        }))
        .sort((a, b) => a.strength - b.strength),
    })),
  }));
}

/** 目前在跑（或剛派出）的 run：最後一筆未結束的紀錄。 */
export function activeRunId(job: LoraTraining): string | null {
  for (const rec of [...job.runs].reverse()) {
    if (!isRecord(rec)) continue;
    const state = str(rec["state"]);
    if (state === "dispatched" || state === "running") return str(rec["run_id"]);
  }
  return null;
}

export function progressDetail(job: Pick<LoraTraining, "phase"> & { progress?: LoraTraining["progress"] }, view: TrainingView | null): string | null {
  if (job.phase === "train" && view !== null && view.steps > 0) return t("{done}／{total} 步", { done: view.done, total: view.steps });
  const p = job.progress;
  if (isRecord(p) && p["phase"] === job.phase && typeof p["done"] === "number" && typeof p["total"] === "number") return t("{done}／{total} 批", { done: p["done"], total: p["total"] });
  return null;
}

const EVENT_TEXT: Record<string, string> = {
  created: t("建立訓練工作"),
  run: t("送出一個執行"),
  clips_done: t("片段切好了"),
  waiting_review: t("等你檢查訓練資料"),
  selected: t("訓練資料選好了"),
  encoded: t("編碼完成"),
  chunk_done: t("完成一段訓練"),
  chunk_paused: t("訓練暫停後會自動接續"),
  auto_resume: t("自動接續訓練"),
  compare_started: t("開始強度比較"),
  waiting_decision: t("比較完成，等你決定"),
  stopped_component: t("暫時卸下閒置的影片模型"),
  restored_component: t("重新載入先前卸下的模型"),
  restore_failed: t("先前卸下的模型沒能重新載入"),
  eval_component: t("準備比較用的 DiT"),
  error: t("出錯，已暫停"),
  busy_retry: t("裝置忙碌，稍後重送"),
  watchdog_stall: t("進度停住太久，已停止，會從存檔接續"),
  stall_retry: t("重送停住的比較"),
  cancel_requested: t("要求取消"),
  resumed: t("繼續"),
  stop_training: t("停止訓練並用目前的 LoRA 比較"),
  decided: t("已決定"),
  registered: t("LoRA 已登錄"),
};

export function eventText(kind: string): string {
  return EVENT_TEXT[kind] ?? kind;
}

export function summaryProgress(item: LoraTrainingSummary): number | null {
  const p = item.progress;
  if (isRecord(p) && typeof p["done"] === "number" && typeof p["total"] === "number" && p["total"] > 0) return p["done"] / p["total"];
  return null;
}

export function formatStrength(s: number): string {
  return s === 0 ? t("不用 LoRA") : `×${String(Number(s.toFixed(2)))}`;
}

export const DIRECTION_SUGGESTIONS: readonly string[] = [
  t("動漫戰鬥的運鏡與打擊感"),
  t("快速剪輯與速度線"),
  t("手繪 2D 的線條與平塗"),
  t("角色表演與表情節奏"),
];
