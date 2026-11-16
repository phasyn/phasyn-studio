// 單元測試用的合成資料（不是模型輸出，也不會出現在畫面上）。prompt_sha256 用「sha:」加上文字代替（測試只比較相等）。
import type { FileRef } from "@/api/generated/contracts";
import type {
  EvaluationRef,
  EvaluationSplit,
  MetricLabel,
  PromptCandidates,
  PromptComparison,
  PromptLanguage,
  PromptScene,
  PromptScore,
  PromptStudy,
  PromptStudyTask,
  PromptStudyVersion,
  PromptTaskRequest,
  PromptTaskResult,
  PromptVariant,
  RenderRef,
  SectionKey,
} from "../types";
import { compileVariant, variantSections } from "./compile";
import { applicableSections, lossBreakdown } from "./loss";
import { DEFAULT_SETTINGS, emptySection } from "./normalize";
import { SECTION_KEYS } from "./sections";

export const FILE: FileRef = { node_id: "node-a", file_id: "file-source", size_bytes: 1024, sha256: "a".repeat(64), media_type: "image/png", metadata: {} };
export const NOW = "2026-10-18T00:00:00.000Z";

export function fileRef(id: string): FileRef {
  return { ...FILE, file_id: id };
}

export const fakeSha = (text: string) => `sha:${text}`;

/** 每個有文字的區段各有一筆觀察（契約要求至少一筆，證據引用同區段）。 */
export function makeScene(texts: Partial<Record<SectionKey, string>>, options: { language?: PromptLanguage; locked?: SectionKey[] } = {}): PromptScene {
  const language = options.language ?? "en";
  const observations: PromptScene["observations"] = [];
  const sections = Object.fromEntries(
    SECTION_KEYS.map((key, index) => {
      const text = texts[key] ?? "";
      const id = `o${String(index + 1).padStart(3, "0")}`;
      if (text) observations.push({ id, view_id: "v-full", section: key, claim_en: `${key} seen`, certainty: "observed" });
      return [
        key,
        {
          ...emptySection(),
          text_en: language === "en" ? text : text ? `${text} (en)` : "",
          text_zh_tw: language === "zh-TW" ? text : "",
          observation_ids: text ? [id] : [],
          locked: options.locked?.includes(key) ?? false,
        },
      ];
    }),
  ) as PromptScene["sections"];
  return { schema_version: 1, prompt_language: language, sections, observations, uncertainty_notes: [] };
}

export function makeCandidates(scene: PromptScene, intentional: SectionKey[] = []): PromptCandidates {
  const items = (["core", "detailed"] as const).map((variant) => {
    const prompt = compileVariant({ scene, intentional }, variant);
    return { variant, prompt, prompt_sha256: fakeSha(prompt), sections: variantSections({ scene, intentional }, variant), token_status: "unchecked" as const, target_tokens: null, token_reason: "測試" };
  });
  return {
    compiler_version: "prompt-compiler/1",
    compiler_sha256: "0".repeat(64),
    language: scene.prompt_language,
    scene_sha256: "scene",
    intentional_changes: intentional,
    identical: items[0]?.prompt_sha256 === items[1]?.prompt_sha256,
    items,
  };
}

export function makeVersion(id: string, number: number, scene: PromptScene, options: { intentional?: SectionKey[]; parent?: string | null } = {}): PromptStudyVersion {
  const intentional = options.intentional ?? [];
  return {
    version_id: id,
    number,
    parent_version_id: options.parent ?? null,
    origin: options.parent ? "refinement" : "analysis",
    scene,
    intentional_changes: intentional,
    candidates: makeCandidates(scene, intentional),
    provenance: { kind: "vision", task_id: null, run_ids: [], vision: null, compile: null },
    note: "",
    created_at: NOW,
  };
}

export function makeStudy(versions: PromptStudyVersion[], tasks: PromptStudyTask[] = []): PromptStudy {
  return {
    study_id: "ps-test",
    title: "測試研究",
    revision: 3,
    created_at: NOW,
    updated_at: NOW,
    language: "en",
    source: { file: FILE, name: "teapot.png", width: 1024, height: 1024, library_item: null },
    crops: [],
    settings: {},
    versions,
    tasks,
    accepted_version_id: null,
    acceptance: null,
    archived: false,
    note: "",
  };
}

export function makeComparison(labels: Partial<Record<SectionKey, MetricLabel>>, options: { unjudgeable?: string | null; differences?: number } = {}): PromptComparison {
  return {
    schema_version: 1,
    sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, { label: labels[key] ?? "match", evidence_zh_tw: `${key} 的依據` }])) as PromptComparison["sections"],
    unexpected_elements: [],
    differences: Array.from({ length: options.differences ?? 0 }, (_, index) => ({ section: "subject" as const, description_zh_tw: `差異 ${index + 1}`, suggested_change_en: `fix ${index + 1}` })),
    text_transcription: "",
    unjudgeable_reason: options.unjudgeable ?? null,
  };
}

/** 依同一套規則算出的分數（loss 指定時直接用指定值，模擬元件回報）。 */
export function makeScore(comparison: PromptComparison, scene: PromptScene, loss?: number | null): PromptScore {
  const applicable = applicableSections(scene);
  const local = lossBreakdown(comparison, applicable);
  const value = loss === undefined ? local.loss : loss;
  return {
    scorer_version: "prompt-score/1",
    rubric: { sha256: "rubric", scene_sha256: "scene", intentional_changes: [], applicable_sections: applicable },
    loss: value,
    evaluable_weight_fraction: local.evaluableWeightFraction,
    unverified: value === null,
    unverified_reasons: value === null ? ["測試：不可判斷"] : [],
    sections: Object.fromEntries(
      local.rows.map((row) => [row.key, { label: row.label, weight: row.weight, applicable: row.applicable, intentional: false, penalty: row.penalty, weighted_penalty: row.weighted }]),
    ) as PromptScore["sections"],
  };
}

interface Spec {
  version: string;
  variant: PromptVariant;
  seed: number;
  split?: EvaluationSplit;
  round?: number;
}

export function renderRef(spec: Spec, runId: string, state: RenderRef["state"] = "succeeded"): RenderRef {
  return {
    kind: "render",
    version_id: spec.version,
    variant: spec.variant,
    seed: spec.seed,
    split: spec.split ?? "search",
    round: spec.round ?? 0,
    run_id: runId,
    state,
    image: state === "succeeded" ? fileRef(`img-${runId}`) : null,
    image_asset: null,
    error: state === "failed" ? { code: "RUNTIME_ERROR", message: "測試失敗" } : null,
  };
}

/** 一張已評分的圖（loss=null＝不可判斷）。 */
export function evaluationRef(spec: Spec, renderRunId: string, runId: string, loss: number | null, scene: PromptScene): EvaluationRef {
  const comparison = makeComparison({}, { differences: 4 });
  return {
    kind: "evaluation",
    version_id: spec.version,
    variant: spec.variant,
    seed: spec.seed,
    split: spec.split ?? "search",
    round: spec.round ?? 0,
    render_run_id: renderRunId,
    run_id: runId,
    comparison,
    score: makeScore(comparison, scene, loss),
  };
}

/** 一張圖的完整紀錄：render ＋ evaluation（run id 用 spec 組出來）。 */
export function scored(spec: Spec, loss: number | null, scene: PromptScene): PromptTaskResult[] {
  const key = `${spec.version}-${spec.variant}-${spec.seed}-${spec.split ?? "search"}-${spec.round ?? 0}`;
  return [renderRef(spec, `r-${key}`), evaluationRef(spec, `r-${key}`, `c-${key}`, loss, scene)];
}

export function reconstructRequest(overrides: Partial<Extract<PromptTaskRequest, { kind: "reconstruct" }>> = {}): Extract<PromptTaskRequest, { kind: "reconstruct" }> {
  return {
    kind: "reconstruct",
    search_seeds: [42, 43],
    holdout_seeds: [142, 143],
    max_rounds: 3,
    max_images: 16,
    max_vision_operations: 96,
    stop_after_no_improvement: 1,
    settings: { ...DEFAULT_SETTINGS, route: "t2i-local", components: { vision: "node-a::vision", compile: "node-a::compile", score: "node-a::score" } },
    ...overrides,
  };
}

/** 任務；runIds 省略時用結果參照引用的 run（依序）。 */
export function makeTask(request: PromptTaskRequest, baseVersionId: string | null, refs: PromptTaskResult[] = [], runIds?: string[]): PromptStudyTask {
  const ids = runIds ?? refs.flatMap((ref) => (ref.kind === "version" ? (ref.run_id ? [ref.run_id] : []) : [ref.run_id])).filter((id, index, all) => all.indexOf(id) === index);
  return {
    task_id: `task-${request.kind}`,
    kind: request.kind,
    state: "running",
    phase: null,
    stop_reason: null,
    base_version_id: baseVersionId,
    request,
    rubric: null,
    run_ids: ids,
    result_refs: refs,
    best: null,
    verification: "analysis_only",
    error: null,
    message: "",
    created_at: NOW,
    updated_at: NOW,
    finished_at: null,
  };
}
