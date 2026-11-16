// 推理 Studio・圖片反推的型別。Prompt* 一律來自契約（contracts/component.schema.json 的 Prompt* 定義，x-phasyn-extension；
// pnpm gen:types 產生到 @/api/generated/contracts），這裡只重新匯出，並放方便用的別名（由契約型別推導，不加任何欄位）。
// 檔尾是本頁自己的型別（生成設定、候選參照、元件選擇），它們存在研究的 settings 與任務 request.settings（契約為自由物件）。
import type {
  PromptCandidate,
  PromptMetric,
  PromptPairwise,
  PromptSectionKey,
  PromptStudyDeletionPlan,
  PromptStudyTask,
  PromptStudyVersion,
  PromptTaskResult,
} from "@/api/generated/contracts";

export type {
  PromptAcceptance,
  PromptCandidate,
  PromptCandidates,
  PromptComparison,
  PromptConfirmation,
  PromptCrop,
  PromptDifference,
  PromptEvaluationRow,
  PromptEvaluationSet,
  PromptLanguage,
  PromptMetric,
  PromptObservation,
  PromptPairwise,
  PromptRanking,
  PromptRubric,
  PromptScene,
  PromptSceneSection,
  PromptScore,
  PromptSectionKey,
  PromptSectionScore,
  PromptStudy,
  PromptStudyDeletionPlan,
  PromptStudyList,
  PromptStudySource,
  PromptStudySummary,
  PromptStudyTask,
  PromptStudyVersion,
  PromptTaskRequest,
  PromptTaskResult,
  PromptVersionProvenance,
  PromptVisionAttempt,
  PromptVisionResult,
  PromptVisionView,
} from "@/api/generated/contracts";

export type SectionKey = PromptSectionKey;
export const SECTION_KEYS: readonly SectionKey[] = ["subject", "action", "composition", "environment", "lighting", "appearance", "style", "visible_text"];

export type PromptVariant = PromptCandidate["variant"];
export const VARIANTS: readonly PromptVariant[] = ["core", "detailed"];

export type MetricLabel = PromptMetric["label"];
export type PairwiseWinner = PromptPairwise["winner"];
export type VersionOrigin = PromptStudyVersion["origin"];

export type CaptionRef = Extract<PromptTaskResult, { kind: "caption" }>;
export type VersionRef = Extract<PromptTaskResult, { kind: "version" }>;
export type RenderRef = Extract<PromptTaskResult, { kind: "render" }>;
export type EvaluationRef = Extract<PromptTaskResult, { kind: "evaluation" }>;
export type PairwiseRef = Extract<PromptTaskResult, { kind: "pairwise" }>;
export type EvaluationSplit = RenderRef["split"];

export type TaskKind = PromptStudyTask["kind"];
export type TaskState = PromptStudyTask["state"];
export type TaskPhase = NonNullable<PromptStudyTask["phase"]>;
export type StopReason = NonNullable<PromptStudyTask["stop_reason"]>;
export type Verification = PromptStudyTask["verification"];

export type DeleteMode = PromptStudyDeletionPlan["mode"];

// ---------------------------------------------------------------- 本頁的型別（存在自由物件 settings 裡）

export interface CandidateRef {
  version_id: string;
  variant: PromptVariant;
}

export type SigmaSchedule = "native" | "karras" | "exponential";
export type DecodeMode = "full" | "tiled";
export type PreviewMode = "off" | "vae_thumbnail" | "linear_fit";

/** 生成設定（t2i 元件組合的參數覆寫）；任務建立時凍結在 request.settings。 */
export interface GenerationSettings {
  /** t2i 元件組合（pipeline_id）。 */
  route: string;
  negative_prompt: string;
  /** 32 的倍數（qimg.dit）。 */
  width: number;
  height: number;
  steps: number;
  /** Qwen 語意：≤1 不用 CFG；>1 啟用負面提示詞並使去噪 forward 加倍。 */
  guidance: number;
  sigma_schedule: SigmaSchedule;
  /** null＝自動（依解析度）。 */
  flow_shift_mu: number | null;
  decode: DecodeMode;
  preview: { mode: PreviewMode; every: number };
}

/** 任務用到的元件 instance（node_id::component_id）。 */
export interface TaskComponents {
  vision: string | null;
  compile: string | null;
  score: string | null;
}

/** request.settings（render／reconstruct）：生成設定＋元件。 */
export interface TaskSettings extends GenerationSettings {
  components: TaskComponents;
}
