// Run 結果整理：收集輸出、同源判斷（latent_id／blob SHA／manifest SHA）、final latent 的 manifest 摘要。
import type { Asset, FileRef, LatentRef, Rational } from "@/api/generated/contracts";
import { asAsset, asTypedValueMap, isFileRef, runSteps, type RunStepView, type WireRun, type WireTypedValue } from "@/api/types";
import { stringifyJson, isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export type SourceRelation = { same: true; reason: null } | { same: false; reason: string };

/** 兩路必須 latent_id、blob SHA、manifest SHA 全部相同才算同源；缺 source_latent 一律不冒充同源。 */
export function compareSources(a: LatentRef | null, b: LatentRef | null): SourceRelation {
  if (!a || !b) return { same: false, reason: t("其中一路沒有 source_latent 紀錄，無法證明同源") };
  const differences: string[] = [];
  if (a.latent_id !== b.latent_id) differences.push("latent_id");
  if (a.blob_sha256 !== b.blob_sha256) differences.push("blob SHA-256");
  if (a.manifest_sha256 !== b.manifest_sha256) differences.push("manifest SHA-256");
  return differences.length === 0 ? { same: true, reason: null } : { same: false, reason: t("{differences} 不同", { differences: formatList(differences) }) };
}

export interface RunValue {
  key: string;
  /** null＝run 層級輸出。 */
  stepId: string | null;
  port: string;
  value: WireTypedValue;
}

/** run 輸出與各步驟輸出（同一檔案／同一 asset 只列一次，以 run 輸出優先）。 */
export function runValues(run: WireRun): RunValue[] {
  const out: RunValue[] = [];
  const seen = new Set<string>();
  const identity = (value: WireTypedValue): string => {
    if ("file" in value) return `file:${value.file.node_id}/${value.file.file_id}`;
    const asset = value.type_id === "media.asset.v1" ? asAsset(value.value) : null;
    return asset ? `asset:${asset.asset_id}` : `inline:${stringifyJson(value.value) ?? ""}`;
  };
  for (const [port, value] of Object.entries(asTypedValueMap(run.outputs))) {
    seen.add(identity(value));
    out.push({ key: `run:${port}`, stepId: null, port, value });
  }
  for (const step of runSteps(run)) {
    for (const [port, value] of Object.entries(step.outputs)) {
      const id = identity(value);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ key: `${step.step_id}:${port}`, stepId: step.step_id, port, value });
    }
  }
  return out;
}

export function runAssets(run: WireRun): Asset[] {
  const assets: Asset[] = [];
  const seen = new Set<string>();
  const collect = (value: WireTypedValue) => {
    if (value.type_id !== "media.asset.v1" || !("value" in value)) return;
    const asset = asAsset(value.value);
    if (asset && !seen.has(asset.asset_id)) {
      seen.add(asset.asset_id);
      assets.push(asset);
    }
  };
  Object.values(asTypedValueMap(run.outputs)).forEach(collect);
  for (const step of runSteps(run)) Object.values(step.outputs).forEach(collect);
  return assets;
}

/** What runs made, for wording that names it: images, videos, or output files in general. */
export type RunOutputKind = "image" | "video" | "other";

/** The file a run-level output carries: a file value, or an asset value with its file. */
function outputFile(value: WireTypedValue): FileRef | null {
  if ("file" in value) return value.file;
  return isRecord(value.value) && isFileRef(value.value["file"]) ? value.value["file"] : null;
}

/**
 * The kind of the runs' own outputs (step intermediates do not count): image when their image and video files are all
 * images, video when they are all videos; both, neither or no output at all → other.
 */
export function runOutputKind(runs: readonly WireRun[]): RunOutputKind {
  const kinds = new Set<"image" | "video">();
  for (const run of runs) {
    for (const value of Object.values(asTypedValueMap(run.outputs))) {
      const family = outputFile(value)?.media_type.split("/")[0];
      if (family === "image" || family === "video") kinds.add(family);
    }
  }
  const [only] = kinds;
  return kinds.size === 1 && only ? only : "other";
}

export function findAsset(run: WireRun, assetId: string): Asset | null {
  return runAssets(run).find((asset) => asset.asset_id === assetId) ?? null;
}

/** 同一 run 中以此 latent 為來源的草稿 asset（用於「從此來源正式解碼」帶入 preview_asset_id）。 */
export function previewAssetForLatent(run: WireRun, latent: FileRef): Asset | null {
  const latentId = typeof latent.metadata["latent_id"] === "string" ? latent.metadata["latent_id"] : null;
  return (
    runAssets(run).find(
      (asset) =>
        asset.kind === "preview" &&
        asset.source_latent !== null &&
        (asset.source_latent.manifest_file.file_id === latent.file_id || (latentId !== null && asset.source_latent.latent_id === latentId)),
    ) ?? null
  );
}

export interface LatentFacts {
  latentId: string | null;
  latentSpaceId: string | null;
  shape: number[] | null;
  dtype: string | null;
  layout: string | null;
  blob: FileRef | null;
}

/** video.final-latent.v1 FileRef 的 manifest 摘要（metadata：latent_id、latent_space_id、shape、dtype、links.blob）。 */
export function latentFacts(file: FileRef): LatentFacts {
  const meta = isRecord(file.metadata) ? file.metadata : {};
  const links = isRecord(meta["links"]) ? meta["links"] : {};
  const rawShape: unknown = meta["shape"];
  const shape = Array.isArray(rawShape) && rawShape.every((item): item is number => typeof item === "number") ? rawShape : null;
  return {
    latentId: typeof meta["latent_id"] === "string" ? meta["latent_id"] : null,
    latentSpaceId: typeof meta["latent_space_id"] === "string" ? meta["latent_space_id"] : null,
    shape,
    dtype: typeof meta["dtype"] === "string" ? meta["dtype"] : null,
    layout: typeof meta["layout"] === "string" ? meta["layout"] : null,
    blob: isFileRef(links["blob"]) ? links["blob"] : null,
  };
}

export function fpsValue(fps: Rational | null): number | null {
  return fps && fps.den > 0 ? fps.num / fps.den : null;
}

/** CFR 總長：frames × den / num（秒）。 */
export function durationSeconds(frameCount: number, fps: Rational | null): number | null {
  return fps && fps.num > 0 ? (frameCount * fps.den) / fps.num : null;
}

/**
 * Steps whose recording the Controller lacks, for the Node-local history: the call was sent (call_id, node_id) and
 * either no recording was reported (no recording_id) or the Controller index no longer lists it (deleted there; the run
 * keeps the id). `indexed` is the index's recording ids of the run, or null while they are unknown (still loading or the
 * read failed): then only steps without a recording_id count, so a pending or failed read never reports one missing.
 */
export function stepsMissingRecording(steps: readonly RunStepView[], indexed: ReadonlySet<string> | null): RunStepView[] {
  return steps.filter((step) => step.call_id != null && step.call_id !== "" && step.node_id != null && step.node_id !== "" && (step.recording_id == null || step.recording_id === "" || (indexed !== null && !indexed.has(step.recording_id))));
}

/** States in which a step ended without succeeding, in the order they are listed after the done count. */
export type EndedStepState = "failed" | "interrupted" | "cancelled" | "skipped";
const ENDED_STATES: readonly EndedStepState[] = ["failed", "interrupted", "cancelled", "skipped"];

export interface StepProgress {
  /** Steps whose state is succeeded: the only state that counts as done. */
  succeeded: number;
  total: number;
  /** succeeded／total; null without steps (no progress is drawn). */
  fraction: number | null;
  /** Steps that ended without succeeding, by state (only states that occur, in ENDED_STATES order); never counted as done. */
  ended: readonly { state: EndedStepState; count: number }[];
}

/**
 * A run's step progress, counted only from the states run.steps reports (never estimated from time, unknown states not
 * filled in). Done means succeeded: skipped, failed, interrupted and cancelled steps are listed separately, so a run
 * whose first step failed and whose other four were skipped reads 0/5, not 4/5. Every run view uses this definition.
 */
export function stepProgress(steps: readonly Pick<RunStepView, "state">[]): StepProgress {
  const succeeded = steps.filter((step) => step.state === "succeeded").length;
  const ended = ENDED_STATES.map((state) => ({ state, count: steps.filter((step) => step.state === state).length })).filter((entry) => entry.count > 0);
  return { succeeded, total: steps.length, fraction: steps.length === 0 ? null : succeeded / steps.length, ended };
}

/** The part each ended state adds after the done count (each translation carries its own leading separator). */
const ENDED_TEXT: Readonly<Record<EndedStepState, (count: number) => string>> = {
  failed: (count) => t("・失敗 {count}", { count }),
  interrupted: (count) => t("・已中斷 {count}", { count }),
  cancelled: (count) => t("・已取消 {count}", { count }),
  skipped: (count) => t("・已略過 {count}", { count }),
};

/** The headline of a step's error box, named after how the step ended: a cancelled or interrupted step did not fail. */
export function stepErrorTitle(step: Pick<RunStepView, "step_id" | "state">): string {
  if (step.state === "cancelled") return t("步驟 {step_id} 已取消", { step_id: step.step_id });
  if (step.state === "interrupted") return t("步驟 {step_id} 已中斷", { step_id: step.step_id });
  return t("步驟 {step_id} 失敗", { step_id: step.step_id });
}

/** The headline of a run-level error box, named after how the run ended. */
export function runErrorTitle(run: Pick<WireRun, "state">): string {
  if (run.state === "cancelled") return t("run 已取消");
  if (run.state === "interrupted") return t("run 已中斷");
  return t("run 失敗");
}

/** The progress line of a run, e.g. "0／5 個步驟完成・失敗 1・已略過 4". */
export function stepProgressText(progress: StepProgress): string {
  const done = t("{succeeded}／{total} 個步驟完成", { succeeded: progress.succeeded, total: progress.total });
  return done + progress.ended.map(({ state, count }) => ENDED_TEXT[state](count)).join("");
}
