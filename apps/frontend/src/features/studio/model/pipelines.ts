// run 的分支結構與結果讀回（渲染 run 由 renderPlan.ts 以元件組合為範本組出），以及序列匯出的參數與結果（請求由 editor/export.ts 組出）。
// 分支的約定：輸出鍵 final（單一分支）或 final_0、final_1…（批次／變體）；批次時每個步驟 id 都加上同一個後綴。
// 這裡不做任何重試或恢復：每次渲染都是新的 run；結果只從 run 的步驟輸出讀回，不向元件組合要 latent 輸出。
import type { ApiErrorBody, Asset, FileRef, StudioTake } from "@/api/generated/contracts";
import { asAsset, parseRunStep, typedFile, type RunStepView, type WireRun } from "@/api/types";
import { t } from "@/i18n";
import { equalRate, validClock } from "./studioGenerationBinding";

const FINAL_KEY = /^final(_\d+)?$/;

/** take.output_key → 分支後綴（final → ""、final_2 → "_2"）。 */
export function branchSuffix(outputKey: string): string {
  return FINAL_KEY.exec(outputKey)?.[1] ?? "";
}

/** run 的分支後綴（依輸出鍵）；不是 Studio 的輸出命名時視為單一分支。 */
export function runBranchSuffixes(run: WireRun): string[] {
  const suffixes = Object.keys(run.request.pipeline.outputs).flatMap((key) => {
    const match = FINAL_KEY.exec(key);
    return match ? [match[1] ?? ""] : [];
  });
  const unique = [...new Set(suffixes)];
  if (unique.length === 0 || unique.includes("")) return [""];
  return unique.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** run 的全部步驟 id（pipeline 順序，再加上 run 記錄裡多出來的）。 */
export function runStepIds(run: WireRun): string[] {
  const order = run.request.pipeline.steps.map((step) => step.step_id);
  const known = new Set(order);
  return [...order, ...Object.keys(run.steps).filter((id) => !known.has(id))];
}

/** 步驟 id → 範本步驟 id（base）與分支後綴；單一分支的 run 一律沒有後綴（範本 id 本身可以含 _數字）。 */
export function splitRunStepId(run: WireRun, stepId: string, suffixes: readonly string[] = runBranchSuffixes(run)): { base: string; suffix: string } {
  for (const suffix of suffixes) {
    if (suffix && stepId.length > suffix.length && stepId.endsWith(suffix)) return { base: stepId.slice(0, -suffix.length), suffix };
  }
  return { base: stepId, suffix: "" };
}

/** 某個輸出鍵（final／final_n）所屬分支的步驟 id，pipeline 順序。 */
export function branchStepIds(run: WireRun, outputKey: string): string[] {
  const suffix = branchSuffix(outputKey);
  const suffixes = runBranchSuffixes(run);
  const ids = runStepIds(run);
  if (suffixes.length === 1 && suffixes[0] === "") return ids;
  return ids.filter((id) => splitRunStepId(run, id, suffixes).suffix === suffix);
}

/** media.concat 的參數（未填＝元件預設：crf 18、preset medium、aac 192000 bps）；audioBitrate 單位是 bps。 */
export interface ExportOptions {
  range?: "sequence" | "work_area";
  crf?: number;
  preset?: "ultrafast" | "veryfast" | "faster" | "fast" | "medium" | "slow";
  audioBitrate?: number;
  /** Integrated loudness target in LUFS (-18, -16 or -14); absent: the mix is exported as it is. */
  loudnessLufs?: number;
  /** proxy: the run is a proxy rendition and takes no run slot. */
  purpose?: "proxy";
  /**
   * gap: clips whose shot is not rendered yet are left out (their time stays silent and empty) instead of blocking the
   * request; the mix audition uses it so the sound can be heard before every shot exists.
   */
  unrendered?: "block" | "gap";
}

export interface ExportTarget {
  node_id: string;
  component_id: string;
  /** The component composites adjustment layers (its descriptor's facts.timeline_export.adjustment). */
  adjustment?: boolean;
}

function elapsedMs(start: string | null, end: string | null): number | null {
  if (!(start != null && start !== "") || !(end != null && end !== "")) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export interface TakeOutcome {
  state: StudioTake["state"];
  asset: Asset | null;
  video_latent: FileRef | null;
  error: ApiErrorBody | null;
  /**
   * Each template step's time (base id); null without timestamps, never 0. No total is stored: nothing reads one, and
   * the run's wall time (stored here before) also covers the other branches of a batch or variations run. A take's
   * total, when needed, is the sum of its own steps, as Image Studio shows it (image-studio model/outcome.ts takeTotal).
   */
  timings_ms: Record<string, number | null>;
}

type OutcomeTake = Pick<StudioTake, "output_key"> & Partial<Pick<StudioTake, "frames" | "expected_fps">>;

function deliveryError(take: OutcomeTake, asset: Asset, typeId: string | undefined): ApiErrorBody | null {
  const expected = take.expected_fps;
  if (!expected) return null;
  if (typeId === "media.asset.v1" && asset.complete && (asset.kind === "final" || asset.kind === "video") &&
    asset.file.media_type.startsWith("video/") && asset.file.size_bytes > 0 && asset.width > 0 && asset.height > 0 && Number.isSafeInteger(asset.frame_count) &&
    asset.frame_count === take.frames && asset.fps && validClock(asset.fps.num, asset.fps.den) && equalRate(asset.fps, expected)) return null;
  return {
    code: "STUDIO_OUTPUT_MISMATCH",
    message: t("交付的影片未符合鏡頭要求的片長或影格率"),
    details: { expected_frames: take.frames, expected_fps: expected, actual_frames: asset.frame_count,
      actual_fps: asset.fps, kind: asset.kind, complete: asset.complete },
  };
}

/**
 * 從 run 讀回某個分支（take.output_key）的結果：成片取自 run 請求中這個輸出鍵指向的步驟輸出；
 * 分支成功即算成功（即使整個 run 之後因別的分支失敗）。失敗原因是分支中依 pipeline 順序第一個失敗的步驟。
 */
export function takeOutcome(run: WireRun, take: OutcomeTake): TakeOutcome {
  const ids = branchStepIds(run, take.output_key);
  const suffixes = runBranchSuffixes(run);
  const views: RunStepView[] = ids.map((id) => parseRunStep(id, run.steps[id]));
  const ref = run.request.pipeline.outputs[take.output_key];
  const finalStep = ref ? parseRunStep(ref.from_step, run.steps[ref.from_step]) : null;
  const value = ref ? finalStep?.outputs[ref.output] : undefined;
  const asset = finalStep?.state === "succeeded" && value && "value" in value ? asAsset(value.value) : null;
  const latentValue = views.map((view) => view.outputs["video_latent"]).find((item) => item !== undefined);
  const timings: Record<string, number | null> = {};
  for (const view of views) timings[splitRunStepId(run, view.step_id, suffixes).base] = elapsedMs(view.started_at, view.finished_at);
  if (asset) {
    const error = deliveryError(take, asset, value?.type_id);
    if (error) return { state: "failed", asset: null, video_latent: null, error, timings_ms: timings };
    return { state: "succeeded", asset, video_latent: latentValue ? typedFile(latentValue) : null, error: null, timings_ms: timings };
  }
  if (run.state === "running") return { state: "rendering", asset: null, video_latent: null, error: null, timings_ms: timings };
  const state: StudioTake["state"] = run.state === "cancelled" ? "cancelled" : run.state === "interrupted" ? "interrupted" : "failed";
  const failed = views.find((view) => view.error);
  const error = failed?.error ?? run.error ?? (run.state === "succeeded" ? { code: "OUTPUT_MISSING", message: t("run 成功但找不到這個鏡頭的輸出") } : null);
  return { state, asset: null, video_latent: null, error, timings_ms: timings };
}

export function exportOutcome(run: WireRun): { state: StudioTake["state"]; asset: Asset | null; error: ApiErrorBody | null; frames: number | null } {
  const concat = parseRunStep("concat", run.steps["concat"]);
  const value = concat.outputs["asset"];
  const asset = concat.state === "succeeded" && value && "value" in value ? asAsset(value.value) : null;
  if (asset) return { state: "succeeded", asset, error: null, frames: asset.frame_count };
  if (run.state === "running") return { state: "rendering", asset: null, error: null, frames: null };
  const state: StudioTake["state"] = run.state === "cancelled" ? "cancelled" : run.state === "interrupted" ? "interrupted" : "failed";
  return { state, asset: null, error: concat.error ?? run.error, frames: null };
}
