// 元件呼叫的 run 組法與結果解讀（純函式）。接線與範例元件組合相同（examples/pipelines/prompt-*.json）：
//   分析   caption（qimg.vision op=caption）→ analyze（op=analyze，吃 caption）→ compile（prompt.scene_compile）
//   修訂   revise（op=revise，場景＋選用的比較）→ compile
//   比較   compare（op=compare：原圖 image、生成圖 generated、凍結場景 scene）→ score（prompt.scene_score op=loss）
//   雙順序 ab（candidate_a＝現任、candidate_b＝挑戰者）→ ba（交換）→ confirm（prompt.scene_score op=confirm）
//   編譯   compile（人工修改的場景）
// 步驟的元件用使用者在檢視器選的 instance（任何 Node）；每一步先檢查元件真的有這些埠，參數再用元件的 parameters_schema
// 檢查，不符就不送出（不假裝套用）。一次 run 內依序執行，不另外重試。
import type { ComponentDescriptor, FileRef, Port } from "@/api/generated/contracts";
import { asTypedValue, isFileRef, type RunRequestBody, type WireBinding, type WireRun, type WireStep, type WireTypedValue } from "@/api/types";
import { isRecord } from "@/lib/json";
import { validateValue } from "@/lib/schema";
import type { PromptCandidates, PromptComparison, PromptConfirmation, PromptCrop, PromptLanguage, PromptPairwise, PromptScene, PromptScore, PromptVisionResult, SectionKey } from "../types";
import type { ResultOutput, StepErrorText } from "./stepError";
import { t } from "@/i18n";

export const TYPES = {
  image: "media.image.v1",
  text: "text.prompt.v1",
  scene: "prompt.scene.v1",
  comparison: "prompt.comparison.v1",
  candidates: "prompt.candidates.v1",
  pairwise: "prompt.pairwise.v1",
  score: "prompt.score.v1",
  confirmation: "prompt.confirmation.v1",
  visionResult: "prompt.vision.result.v1",
} as const;

export type OpBuild = { ok: true; body: RunRequestBody } | { ok: false; problem: StepErrorText };

interface StepSpec {
  stepId: string;
  descriptor: ComponentDescriptor;
  inputs: Record<string, WireBinding>;
  parameters: Record<string, unknown>;
  /** 這一步會用到的輸出埠（檢查元件有沒有）。 */
  outputs: string[];
}

function port(name: string, typeId: string, description: string, required = true, transport: Port["transport"] = "file"): Port {
  return { name, type_id: typeId, required, transport, description };
}

/** The component's ports and parameters against this step (structured, worded when shown); null when they fit. */
function stepProblem(spec: StepSpec): StepErrorText | null {
  const { descriptor } = spec;
  const missingIn = Object.keys(spec.inputs).filter((name) => !descriptor.inputs.some((item) => item.name === name));
  const missingOut = spec.outputs.filter((name) => !descriptor.outputs.some((item) => item.name === name));
  if (missingIn.length > 0 || missingOut.length > 0) {
    return { kind: "interface_mismatch", component_id: descriptor.component_id, provider_id: descriptor.provider_id, inputs: missingIn, outputs: missingOut };
  }
  const schema = descriptor.settings.parameters_schema;
  if (isRecord(schema) && Object.keys(schema).length > 0) {
    const issues = validateValue(schema, spec.parameters, schema);
    if (issues.length > 0) return { kind: "params_rejected", component_id: descriptor.component_id, name: null, issues: issues.map(({ path, message }) => ({ path, message })) };
  }
  return null;
}

function build(
  pipelineId: string,
  label: string,
  ports: Port[],
  values: Record<string, WireTypedValue>,
  steps: StepSpec[],
  outputs: Record<string, { from_step: string; output: string }>,
): OpBuild {
  for (const spec of steps) {
    const problem = stepProblem(spec);
    if (problem) return { ok: false, problem };
  }
  const wireSteps: WireStep[] = steps.map((spec) => ({ step_id: spec.stepId, node_id: spec.descriptor.node_id, component_id: spec.descriptor.component_id, inputs: spec.inputs, parameters: spec.parameters }));
  return { ok: true, body: { pipeline: { pipeline_id: pipelineId, label, inputs: ports, steps: wireSteps, outputs }, inputs: values, label } };
}

const fromInput = (name: string): WireBinding => ({ from_input: name });
const fromStep = (step: string, output: string): WireBinding => ({ from_step: step, output });
const fileValue = (file: FileRef): WireTypedValue => ({ type_id: TYPES.image, file });

/** 研究實際使用的視圖（v-full＋裁切）：編譯時 observation 只能引用這些視圖。 */
export function studyViews(crops: readonly PromptCrop[]): string[] {
  return ["v-full", ...crops.map((crop) => crop.view_id)];
}

export function buildAnalyzeRun(input: { vision: ComponentDescriptor; compile: ComponentDescriptor; source: FileRef; language: PromptLanguage; crops: PromptCrop[]; label: string }): OpBuild {
  return build(
    "prompt-study-analyze",
    input.label,
    [port("image", TYPES.image, t("原圖（研究來源）"))],
    { image: fileValue(input.source) },
    [
      { stepId: "caption", descriptor: input.vision, inputs: { image: fromInput("image") }, parameters: { op: "caption", language: input.language }, outputs: ["result", "caption"] },
      {
        stepId: "analyze",
        descriptor: input.vision,
        inputs: { image: fromInput("image"), caption: fromStep("caption", "caption") },
        parameters: { op: "analyze", language: input.language, crops: input.crops },
        outputs: ["result", "scene"],
      },
      { stepId: "compile", descriptor: input.compile, inputs: { scene: fromStep("analyze", "scene") }, parameters: { intentional_changes: [], views: studyViews(input.crops) }, outputs: ["candidates"] },
    ],
    {
      caption_result: { from_step: "caption", output: "result" },
      analyze_result: { from_step: "analyze", output: "result" },
      caption: { from_step: "caption", output: "caption" },
      scene: { from_step: "analyze", output: "scene" },
      candidates: { from_step: "compile", output: "candidates" },
    },
  );
}

export function buildReviseRun(input: {
  vision: ComponentDescriptor;
  compile: ComponentDescriptor;
  source: FileRef;
  scene: PromptScene;
  comparison: PromptComparison | null;
  instruction: string;
  intentional: SectionKey[];
  language: PromptLanguage;
  crops: PromptCrop[];
  label: string;
}): OpBuild {
  const ports = [port("image", TYPES.image, t("原圖（研究來源）")), port("scene", TYPES.scene, t("目前的場景（鎖定區段逐字保留）"), true, "inline")];
  const values: Record<string, WireTypedValue> = { image: fileValue(input.source), scene: { type_id: TYPES.scene, value: input.scene } };
  const reviseInputs: Record<string, WireBinding> = { image: fromInput("image"), scene: fromInput("scene") };
  if (input.comparison) {
    ports.push(port("comparison", TYPES.comparison, t("要依據的比較（前三個差異）"), true, "inline"));
    values["comparison"] = { type_id: TYPES.comparison, value: input.comparison };
    reviseInputs["comparison"] = fromInput("comparison");
  }
  return build(
    "prompt-study-revise",
    input.label,
    ports,
    values,
    [
      {
        stepId: "revise",
        descriptor: input.vision,
        inputs: reviseInputs,
        parameters: { op: "revise", language: input.language, instruction: input.instruction, intentional_changes: input.intentional, crops: input.crops },
        outputs: ["result", "scene"],
      },
      { stepId: "compile", descriptor: input.compile, inputs: { scene: fromStep("revise", "scene") }, parameters: { intentional_changes: input.intentional, views: studyViews(input.crops) }, outputs: ["candidates"] },
    ],
    { revise_result: { from_step: "revise", output: "result" }, scene: { from_step: "revise", output: "scene" }, candidates: { from_step: "compile", output: "candidates" } },
  );
}

export function buildCompareRun(input: {
  vision: ComponentDescriptor;
  score: ComponentDescriptor;
  source: FileRef;
  generated: FileRef;
  scene: PromptScene;
  intentional: SectionKey[];
  rubricSha256: string | null;
  language: PromptLanguage;
  label: string;
}): OpBuild {
  return build(
    "prompt-study-compare",
    input.label,
    [port("image", TYPES.image, t("原圖")), port("generated", TYPES.image, t("生成圖（白底版）")), port("scene", TYPES.scene, t("任務凍結的場景"), true, "inline")],
    { image: fileValue(input.source), generated: fileValue(input.generated), scene: { type_id: TYPES.scene, value: input.scene } },
    [
      {
        stepId: "compare",
        descriptor: input.vision,
        inputs: { image: fromInput("image"), generated: fromInput("generated"), scene: fromInput("scene") },
        parameters: { op: "compare", language: input.language, intentional_changes: input.intentional },
        outputs: ["result", "comparison"],
      },
      {
        stepId: "score",
        descriptor: input.score,
        inputs: { comparison: fromStep("compare", "comparison"), scene: fromInput("scene") },
        parameters: { op: "loss", intentional_changes: input.intentional, rubric_sha256: input.rubricSha256 },
        outputs: ["score"],
      },
    ],
    { compare_result: { from_step: "compare", output: "result" }, comparison: { from_step: "compare", output: "comparison" }, score: { from_step: "score", output: "score" } },
  );
}

export function buildPairwiseRun(input: {
  vision: ComponentDescriptor;
  score: ComponentDescriptor;
  source: FileRef;
  incumbent: FileRef;
  challenger: FileRef;
  scene: PromptScene;
  intentional: SectionKey[];
  language: PromptLanguage;
  label: string;
}): OpBuild {
  const params = { op: "pairwise", language: input.language, intentional_changes: input.intentional };
  return build(
    "prompt-study-pairwise",
    input.label,
    [port("image", TYPES.image, t("原圖")), port("incumbent", TYPES.image, t("目前最佳的生成圖")), port("challenger", TYPES.image, t("挑戰者的生成圖")), port("scene", TYPES.scene, t("任務凍結的場景"), true, "inline")],
    { image: fileValue(input.source), incumbent: fileValue(input.incumbent), challenger: fileValue(input.challenger), scene: { type_id: TYPES.scene, value: input.scene } },
    [
      {
        stepId: "ab",
        descriptor: input.vision,
        inputs: { image: fromInput("image"), candidate_a: fromInput("incumbent"), candidate_b: fromInput("challenger"), scene: fromInput("scene") },
        parameters: params,
        outputs: ["result", "pairwise"],
      },
      {
        stepId: "ba",
        descriptor: input.vision,
        inputs: { image: fromInput("image"), candidate_a: fromInput("challenger"), candidate_b: fromInput("incumbent"), scene: fromInput("scene") },
        parameters: params,
        outputs: ["result", "pairwise"],
      },
      { stepId: "confirm", descriptor: input.score, inputs: { pairwise_ab: fromStep("ab", "pairwise"), pairwise_ba: fromStep("ba", "pairwise") }, parameters: { op: "confirm" }, outputs: ["confirmation"] },
    ],
    {
      ab_result: { from_step: "ab", output: "result" },
      ba_result: { from_step: "ba", output: "result" },
      ab: { from_step: "ab", output: "pairwise" },
      ba: { from_step: "ba", output: "pairwise" },
      confirmation: { from_step: "confirm", output: "confirmation" },
    },
  );
}

export function buildCompileRun(input: { compile: ComponentDescriptor; scene: PromptScene; intentional: SectionKey[]; crops: PromptCrop[]; label: string }): OpBuild {
  return build(
    "prompt-study-compile",
    input.label,
    [port("scene", TYPES.scene, t("人工修改的場景"), true, "inline")],
    { scene: { type_id: TYPES.scene, value: input.scene } },
    [{ stepId: "compile", descriptor: input.compile, inputs: { scene: fromInput("scene") }, parameters: { intentional_changes: input.intentional, views: studyViews(input.crops) }, outputs: ["candidates"] }],
    { candidates: { from_step: "compile", output: "candidates" } },
  );
}

// ---------------------------------------------------------------- 結果

/** run 輸出（元件組合的 outputs）的 inline 值；沒有或不是 inline 時為 undefined。 */
export function outputValue(run: WireRun, name: string): unknown {
  const typed = isRecord(run.outputs) ? asTypedValue(run.outputs[name]) : null;
  return typed && "value" in typed ? typed.value : undefined;
}

const isScene = (value: unknown): value is PromptScene => isRecord(value) && isRecord(value["sections"]) && Array.isArray(value["observations"]) && (value["prompt_language"] === "en" || value["prompt_language"] === "zh-TW");
const isCandidates = (value: unknown): value is PromptCandidates => isRecord(value) && Array.isArray(value["items"]) && value["items"].length === 2 && typeof value["scene_sha256"] === "string";
const isComparison = (value: unknown): value is PromptComparison => isRecord(value) && isRecord(value["sections"]) && Array.isArray(value["differences"]);
const isScore = (value: unknown): value is PromptScore => isRecord(value) && typeof value["unverified"] === "boolean" && isRecord(value["sections"]) && isRecord(value["rubric"]);
const isPairwise = (value: unknown): value is PromptPairwise => isRecord(value) && (value["winner"] === "A" || value["winner"] === "B" || value["winner"] === "tie" || value["winner"] === "uncertain");
const isConfirmation = (value: unknown): value is PromptConfirmation => isRecord(value) && typeof value["confirmed"] === "boolean" && Array.isArray(value["winners"]);
const isVisionResult = (value: unknown): value is PromptVisionResult => isRecord(value) && typeof value["op"] === "string" && Array.isArray(value["attempts"]);

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: StepErrorText };

const missing = (output: ResultOutput): Parsed<never> => ({ ok: false, problem: { kind: "output_missing", output } });

/** 版本 provenance 用的視覺結果摘要（模型、輸出格式、嘗試次數；原始輸出全文在 recording）。 */
export function visionSummary(result: unknown): Record<string, unknown> | null {
  if (!isVisionResult(result)) return null;
  return {
    op: result.op,
    output_format: result.output_format,
    attempts: result.attempts.length,
    repaired: result.attempts.length > 1,
    views: result.views.map((view) => view.view_id),
    provenance: result.provenance,
  };
}

export function readAnalyze(run: WireRun): Parsed<{ caption: string; scene: PromptScene; candidates: PromptCandidates; vision: Record<string, unknown> | null }> {
  const caption = outputValue(run, "caption");
  const scene = outputValue(run, "scene");
  const candidates = outputValue(run, "candidates");
  if (typeof caption !== "string" || !caption.trim()) return missing("caption");
  if (!isScene(scene)) return missing("scene");
  if (!isCandidates(candidates)) return missing("candidates");
  return { ok: true, value: { caption, scene, candidates, vision: visionSummary(outputValue(run, "analyze_result")) } };
}

export function readRevise(run: WireRun): Parsed<{ scene: PromptScene; candidates: PromptCandidates; vision: Record<string, unknown> | null }> {
  const scene = outputValue(run, "scene");
  const candidates = outputValue(run, "candidates");
  if (!isScene(scene)) return missing("revised_scene");
  if (!isCandidates(candidates)) return missing("candidates");
  return { ok: true, value: { scene, candidates, vision: visionSummary(outputValue(run, "revise_result")) } };
}

export function readCompare(run: WireRun): Parsed<{ comparison: PromptComparison; score: PromptScore }> {
  const comparison = outputValue(run, "comparison");
  const score = outputValue(run, "score");
  if (!isComparison(comparison)) return missing("comparison");
  if (!isScore(score)) return missing("score");
  return { ok: true, value: { comparison, score } };
}

export function readPairwise(run: WireRun): Parsed<{ ab: PromptPairwise; ba: PromptPairwise; confirmation: PromptConfirmation }> {
  const ab = outputValue(run, "ab");
  const ba = outputValue(run, "ba");
  const confirmation = outputValue(run, "confirmation");
  if (!isPairwise(ab) || !isPairwise(ba)) return missing("pairwise");
  if (!isConfirmation(confirmation)) return missing("confirmation");
  return { ok: true, value: { ab, ba, confirmation } };
}

export function readCompile(run: WireRun): Parsed<PromptCandidates> {
  const candidates = outputValue(run, "candidates");
  return isCandidates(candidates) ? { ok: true, value: candidates } : missing("candidates");
}

// ---------------------------------------------------------------- 生成結果

export interface RenderedImage {
  file: FileRef;
  /** image.asset.v1 的值（ImageAsset）；只有檔案時為 null。 */
  asset: Record<string, unknown> | null;
}

function imageFrom(raw: unknown): RenderedImage | null {
  const typed = asTypedValue(raw);
  if (!typed) return null;
  if ("file" in typed) return { file: typed.file, asset: null };
  const value = typed.value;
  if (isRecord(value) && isFileRef(value["file"])) return { file: value["file"], asset: value };
  return null;
}

/** 生成 run 的白底版（給視覺模型與顯示）與透明版；白底版缺少時退回透明版（視覺模型會自己合成白底）。 */
export function renderedImages(run: WireRun): { white: RenderedImage | null; rgba: RenderedImage | null } {
  const record = isRecord(run.outputs) ? run.outputs : {};
  return { white: imageFrom(record["image_white"]), rgba: imageFrom(record["image"]) };
}

export interface RunPreview {
  stepId: string;
  step: number | null;
  total: number | null;
  url: string;
  at: string | null;
}

/** 執行中步驟的最新預覽（run 的 steps[*].preview）；不是最終結果。 */
export function runPreview(run: WireRun): RunPreview | null {
  for (const [stepId, raw] of Object.entries(run.steps)) {
    if (!isRecord(raw) || !isRecord(raw["preview"])) continue;
    const preview = raw["preview"];
    // 與 asRunStepPreview 同一條規則：只接受主控自己的 run 預覽路徑（"//host/…" 會被瀏覽器當成別的主機）。
    if (typeof preview["url"] !== "string" || !preview["url"].startsWith("/api/runs/")) continue;
    return {
      stepId,
      step: typeof preview["step"] === "number" ? preview["step"] : null,
      total: typeof preview["total"] === "number" ? preview["total"] : null,
      url: preview["url"],
      at: typeof preview["at"] === "string" ? preview["at"] : null,
    };
  }
  return null;
}
