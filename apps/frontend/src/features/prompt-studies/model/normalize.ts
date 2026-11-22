// 伺服器資料的解讀：主控在 PUT 與 GET 都用契約驗證研究文件，這裡只做「不會讓畫面壞掉」的結構檢查與預設值，
// 缺少必要欄位時回傳 null（不猜值）。生成設定與元件選擇存在契約的自由物件（settings）裡，所以要寬鬆讀。
import type { FileRef } from "@/api/generated/contracts";
import { isFileRef } from "@/api/types";
import { isFiniteNumber, isListed, isRecord } from "@/lib/json";
import type {
  DecodeMode,
  DeleteMode,
  GenerationSettings,
  PreviewMode,
  PromptSceneSection,
  PromptStudy,
  PromptStudyDeletionPlan,
  PromptStudySummary,
  PromptStudyTask,
  PromptStudyVersion,
  SigmaSchedule,
  TaskComponents,
  TaskSettings,
} from "../types";

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return isListed(value, allowed) ? value : fallback;
}

export function emptySection(): PromptSceneSection {
  return { text_en: "", text_zh_tw: "", explanation_zh_tw: "", observation_ids: [], locked: false };
}

function validVersion(raw: unknown): raw is PromptStudyVersion {
  return (
    isRecord(raw) &&
    typeof raw["version_id"] === "string" &&
    typeof raw["number"] === "number" &&
    isRecord(raw["scene"]) &&
    isRecord(raw["scene"]["sections"]) &&
    Array.isArray(raw["scene"]["observations"]) &&
    isRecord(raw["candidates"]) &&
    Array.isArray(raw["candidates"]["items"])
  );
}

function validTask(raw: unknown): raw is PromptStudyTask {
  return (
    isRecord(raw) &&
    typeof raw["task_id"] === "string" &&
    typeof raw["kind"] === "string" &&
    isRecord(raw["request"]) &&
    typeof raw["request"]["kind"] === "string" &&
    Array.isArray(raw["run_ids"]) &&
    Array.isArray(raw["result_refs"])
  );
}

/** 完整研究文件；沒有 study_id 或來源圖片時為 null。不合格的版本與任務略過（主控本來就不會存不合格的文件）。 */
export function normalizeStudy(raw: unknown): PromptStudy | null {
  if (!isRecord(raw) || typeof raw["study_id"] !== "string" || !raw["study_id"]) return null;
  const source = isRecord(raw["source"]) ? raw["source"] : null;
  if (!source || !isFileRef(source["file"])) return null;
  const acceptance = raw["acceptance"];
  const library = isRecord(source["library_item"]) && typeof source["library_item"]["project_id"] === "string" && typeof source["library_item"]["item_id"] === "string" ? source["library_item"] : null;
  return {
    study_id: raw["study_id"],
    title: str(raw["title"]),
    revision: int(raw["revision"]) ?? 0,
    created_at: str(raw["created_at"]),
    updated_at: str(raw["updated_at"]),
    language: raw["language"] === "en" ? "en" : "zh-TW",
    source: {
      file: source["file"],
      name: str(source["name"], "source"),
      width: int(source["width"]),
      height: int(source["height"]),
      library_item: library ? { project_id: str(library["project_id"]), item_id: str(library["item_id"]) } : null,
    },
    crops: (Array.isArray(raw["crops"]) ? raw["crops"] : []).filter((crop: unknown): crop is PromptStudy["crops"][number] => isRecord(crop) && (crop["view_id"] === "v-crop-1" || crop["view_id"] === "v-crop-2") && ["x0","y0","x1","y1"].every((key) => isFiniteNumber(crop[key]))),
    settings: isRecord(raw["settings"]) ? raw["settings"] : {},
    versions: (Array.isArray(raw["versions"]) ? raw["versions"] : []).filter(validVersion),
    tasks: (Array.isArray(raw["tasks"]) ? raw["tasks"] : []).filter(validTask),
    accepted_version_id: strOrNull(raw["accepted_version_id"]),
    acceptance: isRecord(acceptance) && (acceptance["variant"] === "core" || acceptance["variant"] === "detailed") && typeof acceptance["task_id"] === "string" && (acceptance["run_id"] === null || typeof acceptance["run_id"] === "string") && typeof acceptance["note"] === "string" && typeof acceptance["accepted_at"] === "string"
      ? { variant: acceptance["variant"], task_id: acceptance["task_id"], run_id: acceptance["run_id"], note: acceptance["note"], accepted_at: acceptance["accepted_at"] } : null,
    archived: raw["archived"] === true,
    note: str(raw["note"]),
  };
}

function normalizeSummary(raw: unknown): PromptStudySummary | null {
  if (!isRecord(raw) || typeof raw["study_id"] !== "string" || !raw["study_id"] || !isFileRef(raw["source"])) return null;
  return {
    study_id: raw["study_id"],
    title: str(raw["title"]),
    revision: int(raw["revision"]) ?? 0,
    created_at: str(raw["created_at"]),
    updated_at: str(raw["updated_at"]),
    language: raw["language"] === "en" ? "en" : "zh-TW",
    archived: raw["archived"] === true,
    source: raw["source"],
    source_name: str(raw["source_name"]),
    version_count: int(raw["version_count"]) ?? 0,
    task_count: int(raw["task_count"]) ?? 0,
    running_task_count: int(raw["running_task_count"]) ?? 0,
    accepted_version_id: strOrNull(raw["accepted_version_id"]),
  };
}

export function normalizeSummaryList(raw: unknown): PromptStudySummary[] {
  const items = isRecord(raw) && Array.isArray(raw["items"]) ? raw["items"] : Array.isArray(raw) ? raw : [];
  return items.map(normalizeSummary).filter((item): item is PromptStudySummary => item !== null);
}

/** 刪除範圍（主控依契約產生）；缺欄位時補成「未知／沒有」而不是假裝有資料。 */
export function normalizeDeletionPlan(raw: unknown, studyId: string, mode: DeleteMode): PromptStudyDeletionPlan | null {
  if (!isRecord(raw) || !isRecord(raw["counts"]) || !isRecord(raw["source"]) || !isFileRef(raw["source"]["file"])) return null;
  const counts = raw["counts"];
  return {
    study_id: str(raw["study_id"], studyId),
    title: str(raw["title"]),
    mode: raw["mode"] === "all" || raw["mode"] === "keep_images" ? raw["mode"] : mode,
    revision: int(raw["revision"]) ?? 0,
    dry_run: raw["dry_run"] !== false,
    deleted: raw["deleted"] === true,
    can_delete: raw["can_delete"] === true,
    blocking: (Array.isArray(raw["blocking"]) ? raw["blocking"] : []).filter(isRecord).map((item) => ({
      code: str(item["code"], "BLOCKED"),
      message: str(item["message"]),
      task_id: strOrNull(item["task_id"]),
      run_id: strOrNull(item["run_id"]),
    })),
    counts: {
      versions: int(counts["versions"]) ?? 0,
      tasks: int(counts["tasks"]) ?? 0,
      evaluations: int(counts["evaluations"]) ?? 0,
      images: int(counts["images"]) ?? 0,
      runs_delete: int(counts["runs_delete"]) ?? 0,
      runs_keep: int(counts["runs_keep"]) ?? 0,
    },
    runs: (Array.isArray(raw["runs"]) ? raw["runs"] : []).filter(isRecord).map((row) => ({
      run_id: str(row["run_id"]),
      role: oneOf(row["role"], ["image", "analysis", "unknown"] as const, "unknown"),
      action: oneOf(row["action"], ["delete", "keep", "shared", "missing", "active"] as const, "keep"),
      reason: str(row["reason"]),
      files: int(row["files"]) ?? 0,
      status: oneOf(row["status"], ["planned", "deleted", "missing", "failed", "kept"] as const, "planned"),
      message: strOrNull(row["message"]),
    })),
    source: {
      file: raw["source"]["file"],
      action: raw["source"]["action"] === "delete" ? "delete" : "keep",
      reason: str(raw["source"]["reason"]),
      status: oneOf(raw["source"]["status"], ["planned", "deleted", "missing", "kept", "failed"] as const, "kept"),
    },
  };
}

// ---------------------------------------------------------------- 生成設定（自由物件）

export const DEFAULT_SETTINGS: GenerationSettings = {
  route: "",
  negative_prompt: "",
  width: 1024,
  height: 1024,
  steps: 40,
  guidance: 1,
  sigma_schedule: "native",
  flow_shift_mu: null,
  decode: "full",
  preview: { mode: "off", every: 5 },
};

export function normalizeSettings(raw: unknown): GenerationSettings | null {
  if (!isRecord(raw)) return null;
  const preview = isRecord(raw["preview"]) ? raw["preview"] : {};
  return {
    route: str(raw["route"]),
    negative_prompt: str(raw["negative_prompt"]),
    width: int(raw["width"]) ?? DEFAULT_SETTINGS.width,
    height: int(raw["height"]) ?? DEFAULT_SETTINGS.height,
    steps: int(raw["steps"]) ?? DEFAULT_SETTINGS.steps,
    guidance: finite(raw["guidance"]) ?? DEFAULT_SETTINGS.guidance,
    sigma_schedule: oneOf<SigmaSchedule>(raw["sigma_schedule"], ["native", "karras", "exponential"], "native"),
    flow_shift_mu: finite(raw["flow_shift_mu"]),
    decode: oneOf<DecodeMode>(raw["decode"], ["full", "tiled"], "full"),
    preview: { mode: oneOf<PreviewMode>(preview["mode"], ["off", "vae_thumbnail", "linear_fit"], "off"), every: int(preview["every"]) ?? DEFAULT_SETTINGS.preview.every },
  };
}

export function normalizeComponents(raw: unknown): TaskComponents {
  const record = isRecord(raw) ? raw : {};
  return { vision: strOrNull(record["vision"]), compile: strOrNull(record["compile"]), score: strOrNull(record["score"]) };
}

/** render／reconstruct 任務 request.settings（本頁寫入的 TaskSettings）；讀不出生成設定時為 null。 */
export function taskSettings(raw: unknown): TaskSettings | null {
  const settings = normalizeSettings(raw);
  if (!settings) return null;
  return { ...settings, components: normalizeComponents(isRecord(raw) ? raw["components"] : null) };
}

/** 研究 settings 裡本頁記住的生成設定與元件選擇（沒有時為 null）。 */
export function studySettings(study: Pick<PromptStudy, "settings">): { generation: GenerationSettings | null; components: TaskComponents } {
  const raw = study.settings;
  return { generation: normalizeSettings(raw["generation"]), components: normalizeComponents(raw["components"]) };
}

export function fileOrNull(value: unknown): FileRef | null {
  return isFileRef(value) ? value : null;
}
