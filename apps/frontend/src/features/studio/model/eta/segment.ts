// Render-time estimates for Studio segments: the pluggable, asynchronous estimator interface and the plan aggregate.
// A data-driven implementation (profileEstimator.ts, fed with this deployment's cost profiles) plugs in through the
// same interface; without one, NO_ETA answers null and the UI says there is no estimate yet instead of guessing.
// Inputs are plain serialisable values (usable as a query key or a request body).
import { t } from "@/i18n";

/** A reference picture or video size; null when it is not known yet (then the segment gets no estimate). */
type Size = { width: number | null; height: number | null };

export interface SegmentEtaInput {
  /** Compute route (pipeline_id); null when none is selected. */
  routeId: string | null;
  /** Node and component of the route's DiT step; null when the route has no DiT step. */
  ditNodeId: string | null;
  ditComponentId: string | null;
  /** Generated frames of the segment (17n+5). */
  frames: number;
  /** Reference images (characters) sent with the segment; 0 when there are none. */
  characters: number;
  /** TE `reference_video_short_edge` (experimental parameter); null on the official path. */
  referenceVideoShortEdge: number | null;
  /** TE `reference_image_short_edge` (the route's step parameter or the component's saved default); null or absent = 2048. */
  referenceImageShortEdge?: number | null;
  /** DiT sampling steps in effect (pipeline step parameter or the component's saved default); null when unknown. */
  steps: number | null;
  /** Optional request facts a data-driven estimator needs; without them it may answer null. */
  task?: "t2va" | "fl2va" | "ref2va";
  /** Output canvas; defaults to the route's. */
  width?: number;
  height?: number;
  /** Prompt token count (exact, or counted without the tokenizer when `textTokensApproximate`), or the prompt's character count to approximate it. */
  textTokens?: number;
  textTokensApproximate?: boolean;
  promptCharacters?: number;
  /** Reference pictures (source sizes); required when `characters` > 0. */
  images?: readonly Size[];
  /** Reference videos: source size, used seconds, whether their embedded audio is sent. */
  videos?: readonly (Size & { seconds: number; withAudio: boolean })[];
  audios?: readonly { seconds: number }[];
  /** fl2va first frame. */
  keyframe?: boolean;
  /** An earlier segment of the same run used the same components: they are loaded and warm (no load or cold start). */
  continuesBatch?: boolean;
}

/**
 * How an estimate was obtained (section 9): fitted = every stage has a cost profile for this exact setup; partial =
 * some stages have none; approx = borrowed from a different setup of the same component; unknown = no data.
 */
export type EtaBasis = "fitted" | "partial" | "approx" | "unknown";

/** Memory risk of a segment: oom = this size or a smaller one ran out of memory here; beyond_measured = larger than every size that succeeded. */
export type EtaRisk = "oom" | "beyond_measured";

export const ETA_RISK_LABEL: Readonly<Record<EtaRisk, string>> = {
  oom: t("可能記憶體不足"),
  beyond_measured: t("超出實測範圍"),
};

export const ETA_RISK_DETAIL: Readonly<Record<EtaRisk, string>> = {
  oom: t("本機曾有同樣大小或更小的請求因記憶體不足而失敗"),
  beyond_measured: t("比本機成功跑過的請求都大：預估是外推的，也可能記憶體不足"),
};

const RISK_RANK: Readonly<Record<EtaRisk, number>> = { beyond_measured: 1, oom: 2 };

/** The more serious of two risks (oom outranks beyond_measured). */
export function worseRisk(a: EtaRisk | null | undefined, b: EtaRisk | null | undefined): EtaRisk | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RISK_RANK[b] > RISK_RANK[a] ? b : a;
}

export interface SegmentEta {
  seconds: number;
  /** Optional uncertainty band (seconds). */
  low?: number;
  high?: number;
  /** "unknown" is treated as no estimate. */
  basis: EtaBasis;
  /** Recordings the estimate is based on. */
  samples?: number;
  /** Memory risk of this segment's size; absent when none is known. */
  risk?: EtaRisk;
  /** Typical (p50) seconds of each route step the estimate knows, by route step id (for converging while it runs). */
  steps?: Readonly<Record<string, number>>;
  /** Route step ids on the longest chain, in execution order (parallel branches take the longest). */
  criticalPath?: readonly string[];
}

export interface SegmentEtaEstimator {
  /** Stable identity (part of the query key). */
  readonly id: string;
  /** One result per input, in order; null = no estimate for that segment. */
  estimate(segments: readonly SegmentEtaInput[], signal?: AbortSignal): Promise<readonly (SegmentEta | null)[]>;
}

/** No data yet: every estimate is unknown. */
export const NO_ETA: SegmentEtaEstimator = { id: "none", estimate: (segments) => Promise.resolve(segments.map(() => null)) };

/** Shown wherever an estimate would go but there is none. */
export const ETA_UNAVAILABLE = t("尚無預估（完成第一次生成後開始估算）");

export interface PlanEta {
  /** Weakest basis among the segments (fitted < approx); a partial segment gives no plan estimate at all. */
  basis: Exclude<EtaBasis, "unknown" | "partial">;
  totalSeconds: number;
  /** Band of the total (the segments' bands added up); null unless every segment reports one. */
  lowSeconds: number | null;
  highSeconds: number | null;
  shortestSeconds: number;
  longestSeconds: number;
  /** Fewest recordings behind any segment; null when not reported. */
  samples: number | null;
  /** The worst memory risk of any segment; null = none. */
  risk: EtaRisk | null;
}

type PlanBasis = Exclude<EtaBasis, "unknown" | "partial">;
const BASIS_RANK: Record<PlanBasis, number> = { fitted: 0, approx: 1 };

/**
 * Aggregates per-segment estimates into a plan estimate (segments run one after another, so times and band edges add
 * up). Null when there are no segments, or any segment has no estimate or only a partial one (some step without a
 * cost profile, so its time covers the known steps only): a partial sum would understate the plan. Memory risks are
 * reported separately (etaRisks), also then.
 */
export function planEta(results: readonly (SegmentEta | null)[]): PlanEta | null {
  const estimates: (SegmentEta & { basis: PlanBasis })[] = [];
  for (const item of results) {
    if (!item || item.basis === "unknown" || item.basis === "partial" || !Number.isFinite(item.seconds) || item.seconds < 0) return null;
    estimates.push({ ...item, basis: item.basis });
  }
  if (estimates.length === 0) return null;
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const lows = estimates.map((item) => item.low);
  const highs = estimates.map((item) => item.high);
  const samples = estimates.map((item) => item.samples);
  const seconds = estimates.map((item) => item.seconds);
  return {
    basis: estimates.reduce<PlanBasis>((worst, item) => (BASIS_RANK[item.basis] > BASIS_RANK[worst] ? item.basis : worst), "fitted"),
    totalSeconds: sum(seconds),
    lowSeconds: lows.every((value): value is number => value !== undefined) ? sum(lows) : null,
    highSeconds: highs.every((value): value is number => value !== undefined) ? sum(highs) : null,
    shortestSeconds: Math.min(...seconds),
    longestSeconds: Math.max(...seconds),
    samples: samples.every((value): value is number => value !== undefined) ? Math.min(...samples) : null,
    risk: estimates.reduce<EtaRisk | null>((worst, item) => worseRisk(worst, item.risk), null),
  };
}

export interface EtaRisks {
  /** The worst risk of any segment; null = none. */
  worst: EtaRisk | null;
  /** Positions (0-based, input order) of the segments with each risk. */
  oom: number[];
  beyondMeasured: number[];
}

/** Memory risks of every segment that has an estimate (also when the plan as a whole has none). */
export function etaRisks(results: readonly (SegmentEta | null)[]): EtaRisks {
  const out: EtaRisks = { worst: null, oom: [], beyondMeasured: [] };
  results.forEach((item, index) => {
    if (item?.risk === "oom") out.oom.push(index);
    else if (item?.risk === "beyond_measured") out.beyondMeasured.push(index);
    out.worst = worseRisk(out.worst, item?.risk);
  });
  return out;
}

/** 「約 1 小時 35 分」「約 9 分 32 秒」；approx=false drops「約」(second half of a range). */
export function formatEta(totalSeconds: number, options: { approx?: boolean } = {}): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const approx = options.approx !== false;
  if (hours > 0) return approx ? t("約 {hours} 小時 {minutes} 分", { hours, minutes }) : t("{hours} 小時 {minutes} 分", { hours, minutes });
  return approx ? t("約 {minutes} 分 {value} 秒", { minutes, value: s % 60 }) : t("{minutes} 分 {value} 秒", { minutes, value: s % 60 });
}
