// Predicted work of one MiniMax H3 render segment, computed from the request alone (pure; no network, no timing).
// The quantities follow the pinned H3 runtime: frames snap up to 17n+5, the VAE compresses 16× in space and 4× in
// time in 17-frame clips, the DiT packs 2×2 patches (one row per 32×32 px of a latent frame) plus two 40 Hz stereo
// audio rows, Qwen3-VL sees 32×32 px tokens (patch 16 × merge 2) and the packed sequence is padded to 64 rows. The
// FLOP counts use the transformer shapes (layers, width, heads, FFN) from the model's config files.
// Every constant can be overridden by the `facts.cost_model` a Node reports in the component's full descriptor (the
// keys are FACT_KEYS); whatever is missing falls back to the architecture defaults below and is reported as "default".
// The predicted stages carry the system-wide stage names and units (stages.ts), the same H3 records for each call.
// Nothing here is a measured time or throughput.
import { isRecord } from "@/lib/json";
import { H3_RULES } from "../providerTraits";
import { REFERENCE_MAX_RATIO, REFERENCE_MULTIPLE, REFERENCE_SHORT_EDGE, roundHalfEven } from "../../swap/referenceImage";
import { ROW_RISK_UNIT, STAGE_UNITS, type H3Stage, type WorkUnit } from "./stages";

export type H3Task = "t2va" | "fl2va" | "ref2va";
export type ConstantsSource = "descriptor" | "default";

/** DiT FLOPs per sampling step: `perRow·seq + perRowSquared·seq²`; the packed sequence is padded to `rowAlign`. */
export interface DitCostConstants {
  flopsPerRow: number;
  flopsPerRowSquared: number;
  rowAlign: number;
}

/** Text-encoder FLOPs for S conditioning tokens: `perToken·S + perTokenSquared·S²`; `hidden` sizes the bf16 conditioning. */
export interface TeCostConstants {
  flopsPerToken: number;
  flopsPerTokenSquared: number;
  hidden: number;
}

export interface H3GeometryConstants {
  fps: number;
  /** Frames snap up to `frameGroup·n + frameOffset` (17n+5). */
  frameGroup: number;
  frameOffset: number;
  /** Latent frames per full clip and for the leading frames: latent_t(F) = ((F − offset) // group)·latentPerGroup + latentHead. */
  latentPerGroup: number;
  latentHead: number;
  /** Pixels per DiT row side (VAE spatial factor × DiT patch). */
  tokenStride: number;
  audioLatentHz: number;
  /** Audio rows per latent step (stereo). */
  audioChannels: number;
  audioSampleRate: number;
  /** Reference video canvas (adapt_shape_v1): short edge, soft area cap, multiple. */
  referenceVideoShortEdge: number;
  referenceVideoMaxPixels: number;
  canvasMultiple: number;
  /** Reference image preparation: short edge scaled to this, each side snapped to the multiple. */
  referenceImageShortEdge: number;
  referenceImageMultiple: number;
}

export interface QwenProcessorConstants {
  /** Pixels per vision token side (patch × merge). */
  factor: number;
  temporalPatch: number;
  /** Frames Qwen samples per second of reference video. */
  sampleFps: number;
  imageMinPixels: number;
  imageMaxPixels: number;
  videoMinPixels: number;
  videoMaxPixels: number;
  /** Vision start/end tokens around each image or temporal patch. */
  wrapTokens: number;
}

export interface H3Constants {
  dit: DitCostConstants;
  te: TeCostConstants;
  geometry: H3GeometryConstants;
  qwen: QwenProcessorConstants;
  source: { dit: ConstantsSource; te: ConstantsSource; geometry: ConstantsSource; qwen: ConstantsSource };
}

/** H3 transformer shape (transformer/config.json): 50 layers, hidden 5376, 56 heads × 128, FFN 14336. */
export const H3_DIT_SHAPE = { layers: 50, hidden: 5376, heads: 56, headDim: 128, ffn: 14336 } as const;
/** Qwen3-VL text encoder up to the conditioning tap (text_encoder/config.json; tap at layer 50). */
export const H3_TE_SHAPE = { layers: 50, hidden: 5120, heads: 64, kvHeads: 8, headDim: 128, ffn: 25600 } as const;

/** Per-row DiT FLOPs from the block shape: q/k/v (3·H·A), out (A·H), gated MLP in (H·2F) and out (F·H), ×2 per MAC. */
export function ditFlopCoefficients(shape: { layers: number; hidden: number; heads: number; headDim: number; ffn: number }): Pick<DitCostConstants, "flopsPerRow" | "flopsPerRowSquared"> {
  const attention = shape.heads * shape.headDim;
  const block = shape.hidden * 3 * attention + attention * shape.hidden + shape.hidden * 2 * shape.ffn + shape.ffn * shape.hidden;
  return { flopsPerRow: 2 * shape.layers * block, flopsPerRowSquared: 4 * shape.layers * attention };
}

/** Per-token text-encoder FLOPs: q (H·A), k and v (2·H·kv·d), out (A·H), SwiGLU MLP (3·H·F), ×2 per MAC. */
export function teFlopCoefficients(shape: { layers: number; hidden: number; heads: number; kvHeads: number; headDim: number; ffn: number }): Pick<TeCostConstants, "flopsPerToken" | "flopsPerTokenSquared"> {
  const attention = shape.heads * shape.headDim;
  const layer = shape.hidden * attention + 2 * shape.hidden * shape.kvHeads * shape.headDim + attention * shape.hidden + 3 * shape.hidden * shape.ffn;
  return { flopsPerToken: 2 * shape.layers * layer, flopsPerTokenSquared: 2 * shape.layers * attention };
}

export const H3_DEFAULTS: Omit<H3Constants, "source"> = {
  dit: { ...ditFlopCoefficients(H3_DIT_SHAPE), rowAlign: 64 },
  te: { ...teFlopCoefficients(H3_TE_SHAPE), hidden: H3_TE_SHAPE.hidden },
  geometry: {
    fps: H3_RULES.fps,
    frameGroup: H3_RULES.frameGroup,
    frameOffset: H3_RULES.frameOffset,
    latentPerGroup: 5,
    latentHead: 2,
    tokenStride: 32,
    audioLatentHz: 40,
    audioChannels: 2,
    audioSampleRate: 32_000,
    referenceVideoShortEdge: 768,
    referenceVideoMaxPixels: 768 * 1344,
    canvasMultiple: 32,
    referenceImageShortEdge: REFERENCE_SHORT_EDGE,
    referenceImageMultiple: REFERENCE_MULTIPLE,
  },
  // Qwen3-VL processor configs (preprocessor_config.json / video_preprocessor_config.json) and the H3 sampling rate
  qwen: { factor: 32, temporalPatch: 2, sampleFps: 2, imageMinPixels: 65_536, imageMaxPixels: 16_777_216, videoMinPixels: 4_096, videoMaxPixels: 25_165_824, wrapTokens: 2 },
};

/**
 * `facts.cost_model` field names, per constant (snake_case as on the wire). H3 describes its DiT and text-encoder
 * components with exactly these keys (runtimes/h3 recipe/adapter/cost_model.py).
 */
export const FACT_KEYS = {
  dit: { flopsPerRow: "flops_per_row", flopsPerRowSquared: "flops_per_row_squared", rowAlign: "row_align" },
  te: { flopsPerToken: "flops_per_token", flopsPerTokenSquared: "flops_per_token_squared", hidden: "hidden_size" },
  geometry: {
    fps: "fps",
    frameGroup: "frame_group",
    frameOffset: "frame_offset",
    latentPerGroup: "latent_per_group",
    latentHead: "latent_head",
    tokenStride: "token_stride",
    audioLatentHz: "audio_latent_hz",
    audioChannels: "audio_channels",
    audioSampleRate: "audio_sample_rate",
    referenceVideoShortEdge: "reference_video_short_edge",
    referenceVideoMaxPixels: "reference_video_max_pixels",
    canvasMultiple: "canvas_multiple",
    referenceImageShortEdge: "reference_image_short_edge",
    referenceImageMultiple: "reference_image_multiple",
  },
  qwen: {
    factor: "qwen_factor",
    temporalPatch: "qwen_temporal_patch",
    sampleFps: "qwen_sample_fps",
    imageMinPixels: "qwen_image_min_pixels",
    imageMaxPixels: "qwen_image_max_pixels",
    videoMinPixels: "qwen_video_min_pixels",
    videoMaxPixels: "qwen_video_max_pixels",
    wrapTokens: "qwen_wrap_tokens",
  },
} as const;

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Fills one constant group from the facts; "descriptor" only when every field came from them. */
function group<T extends Record<keyof T, number>>(defaults: T, keys: { [K in keyof T]: string }, facts: readonly Record<string, unknown>[]): { value: T; source: ConstantsSource } {
  const overrides: Partial<Record<keyof T, number>> = {};
  let all = true;
  for (const name in keys) {
    if (!Object.hasOwn(keys, name)) continue;
    const found = facts.map((item) => positive(item[keys[name]])).find((item) => item !== undefined);
    if (found === undefined) all = false;
    else overrides[name] = found;
  }
  return { value: { ...defaults, ...overrides }, source: all ? "descriptor" : "default" };
}

/**
 * Constants for this route: `cost_model` facts of the DiT and TE descriptors (unknown JSON, read defensively; a
 * `cost_model` key inside is unwrapped) over the architecture defaults.
 */
export function resolveH3Constants(facts: { dit?: unknown; te?: unknown } = {}): H3Constants {
  const unwrap = (value: unknown): Record<string, unknown> => (isRecord(value) ? (isRecord(value["cost_model"]) ? value["cost_model"] : value) : {});
  const dit = unwrap(facts.dit);
  const te = unwrap(facts.te);
  const ditGroup = group(H3_DEFAULTS.dit, FACT_KEYS.dit, [dit]);
  const teGroup = group(H3_DEFAULTS.te, FACT_KEYS.te, [te]);
  const geometryGroup = group(H3_DEFAULTS.geometry, FACT_KEYS.geometry, [te, dit]);
  const qwenGroup = group(H3_DEFAULTS.qwen, FACT_KEYS.qwen, [te]);
  return {
    dit: ditGroup.value,
    te: teGroup.value,
    geometry: geometryGroup.value,
    qwen: qwenGroup.value,
    source: { dit: ditGroup.source, te: teGroup.source, geometry: geometryGroup.source, qwen: qwenGroup.source },
  };
}

// ---------------------------------------------------------------------------------------------- geometry rules

/** Frames snapped up to 17n+5 (≤ 0 → 1, as the runtime does). */
export function alignedFrames(frames: number, g: H3GeometryConstants = H3_DEFAULTS.geometry): number {
  const f = Math.round(frames);
  if (f <= 0) return 1;
  return f + ((((g.frameOffset - f) % g.frameGroup) + g.frameGroup) % g.frameGroup);
}

/** Latent frames of a clip: ((F − 5) // 17)·5 + 2, and 2 for F ≤ 5. */
export function latentFrames(frames: number, g: H3GeometryConstants = H3_DEFAULTS.geometry): number {
  if (frames <= g.frameOffset) return g.latentHead;
  return Math.floor((frames - g.frameOffset) / g.frameGroup) * g.latentPerGroup + g.latentHead;
}

/** DiT rows per latent frame. */
export function rowsPerFrame(width: number, height: number, g: H3GeometryConstants = H3_DEFAULTS.geometry): number {
  return Math.floor(height / g.tokenStride) * Math.floor(width / g.tokenStride);
}

/** Audio rows for a duration: stereo × round(seconds · 40 Hz) (Python rounding). */
export function audioRows(seconds: number, g: H3GeometryConstants = H3_DEFAULTS.geometry): number {
  return g.audioChannels * roundHalfEven(seconds * g.audioLatentHz);
}

function nearestMultiple(value: number, multiple: number): number {
  return Math.max(multiple, roundHalfEven(value / multiple) * multiple);
}

/** H3 accepts references between 1:4 and 4:1. */
const withinRatio = (width: number, height: number) => width <= REFERENCE_MAX_RATIO * height && height <= REFERENCE_MAX_RATIO * width;

/** Reference image as H3 prepares it (resolve_reference_image_shape): short edge scaled, sides snapped; null when rejected. */
export function preparedImage(width: number, height: number, g: H3GeometryConstants = H3_DEFAULTS.geometry): { width: number; height: number } | null {
  if (!(width > 0 && height > 0) || !withinRatio(width, height)) return null;
  const scale = g.referenceImageShortEdge / Math.min(width, height);
  return { width: nearestMultiple(width * scale, g.referenceImageMultiple), height: nearestMultiple(height * scale, g.referenceImageMultiple) };
}

/** Reference video canvas (adapt_shape_v1): short edge × ratio, scaled down to the area cap, each side to the nearest 32; null outside 1:4–4:1. */
export function referenceVideoCanvas(width: number, height: number, shortEdge: number, g: H3GeometryConstants = H3_DEFAULTS.geometry): { width: number; height: number } | null {
  if (!(width > 0 && height > 0 && shortEdge > 0) || !withinRatio(width, height)) return null;
  const ratio = width / height;
  let w = ratio >= 1 ? shortEdge * ratio : shortEdge;
  let h = ratio >= 1 ? shortEdge : shortEdge / ratio;
  if (w * h > g.referenceVideoMaxPixels) {
    const scale = Math.sqrt(g.referenceVideoMaxPixels / (w * h));
    w *= scale;
    h *= scale;
  }
  return { width: nearestMultiple(w, g.canvasMultiple), height: nearestMultiple(h, g.canvasMultiple) };
}

/**
 * Qwen processor resize: each side to a multiple of `factor`, then shrunk or grown into [min, max] pixels. For video
 * the bound covers all sampled frames (their count rounded to the temporal patch), as the video processor does.
 */
export function qwenResize(width: number, height: number, factor: number, minPixels: number, maxPixels: number, frames = 1, temporalPatch = 1): { width: number; height: number } {
  let w = roundHalfEven(width / factor) * factor;
  let h = roundHalfEven(height / factor) * factor;
  const t = frames > 1 ? Math.max(temporalPatch, roundHalfEven(frames / temporalPatch) * temporalPatch) : 1;
  if (t * w * h > maxPixels) {
    const beta = Math.sqrt((frames * width * height) / maxPixels);
    w = Math.max(factor, Math.floor(width / beta / factor) * factor);
    h = Math.max(factor, Math.floor(height / beta / factor) * factor);
  } else if (t * w * h < minPixels) {
    const beta = Math.sqrt(minPixels / (frames * width * height));
    w = Math.ceil((width * beta) / factor) * factor;
    h = Math.ceil((height * beta) / factor) * factor;
  }
  return { width: w, height: h };
}

/**
 * Rough token count of a prompt when the tokenizer is not available: one token per CJK character plus one per four
 * other characters. Only used to size the estimate; the result is flagged as estimated.
 */
export function approximateTextTokens(text: string): number {
  const cjk = text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/gu)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

// ---------------------------------------------------------------------------------------------- request → work

export interface H3SegmentRequest {
  task: H3Task;
  /** Output canvas (multiples of 32). */
  width: number;
  height: number;
  /** Requested frames (snapped up to 17n+5). */
  frames: number;
  /** DiT sampling steps; null when unknown (then the denoise work is unknown too). */
  steps: number | null;
  /**
   * Prompt length: a token count (`approximate` when it was counted without the tokenizer), or the text / character
   * count to approximate it.
   */
  text: { tokens: number; approximate?: boolean } | { text: string } | { characters: number };
  /** Reference pictures (source size). */
  images?: readonly { width: number; height: number }[];
  /** Reference videos: source size, used seconds, whether their embedded audio is sent. */
  videos?: readonly { width: number; height: number; seconds: number; withAudio: boolean }[];
  /** Reference audio clips (used seconds). */
  audios?: readonly { seconds: number }[];
  /** fl2va: the first frame is a keyframe at the output canvas. */
  keyframe?: boolean;
  /** TE `reference_video_short_edge` (null / undefined = official short edge). */
  referenceVideoShortEdge?: number | null;
  /** TE `reference_image_short_edge` (null / undefined = the official short edge). */
  referenceImageShortEdge?: number | null;
}

/**
 * How far a prompt length counted without the tokenizer is trusted (method policy like the bands in estimate.ts, not a
 * measurement): the tokenizer may merge characters (Qwen often makes one token of two CJK characters or of a whole
 * word) or split a rare one into several byte tokens. A risk measure that includes such a count carries this band.
 */
export const APPROX_TEXT_TOKEN_BAND = { low: 0.5, high: 2 } as const;

export interface StageWork {
  stage: H3Stage;
  /** Null when it cannot be computed (denoise without a known step count). */
  work: number | null;
  unit: WorkUnit;
  /**
   * What the stage's out-of-memory limits are compared with, in `unit` (denoise: the used rows L). `range`: where the
   * measure may lie when it includes an estimate (an approximate prompt length); absent when it is exact.
   */
  risk?: { measure: number; unit: string; range?: { low: number; high: number } };
}

export interface H3Work {
  frames: number;
  latentFrames: number;
  rowsPerFrame: number;
  /** Target video rows plus the target's audio rows. */
  targetRows: number;
  referenceRows: { image: number; video: number; videoAudio: number; audio: number; keyframe: number };
  qwenTokens: { text: number; image: number; video: number; keyframe: number };
  textTokensEstimated: boolean;
  /** Conditioning tokens S (Qwen text + vision). */
  conditioningTokens: number;
  /** Used rows L = S + reference rows + target rows. */
  usedRows: number;
  /** Packed sequence (L padded to the row alignment). */
  seq: number;
  steps: number | null;
  ditFlopPerStep: { linear: number; attention: number };
  /** steps × per-step FLOPs; null when steps are unknown. */
  ditFlop: number | null;
  teFlop: number;
  px: { refImage: number; refVideoFrames: number; keyframe: number; outputFrames: number };
  /** Seconds of reference audio the audio encoder reads (clips plus embedded tracks). */
  referenceAudioSeconds: number;
  outputSeconds: number;
  /** Conditioning (S × hidden × bf16) and the prepared payload (RGB u8 frames, f32 stereo audio). */
  bytes: { conditioning: number; preparedPayload: number };
  /** References H3 rejects (ratio beyond 1:4–4:1); they add no work. */
  rejectedReferences: number;
  stages: StageWork[];
  constantsSource: H3Constants["source"];
}

const BF16_BYTES = 2;
const F32_BYTES = 4;
const RGB_U8_BYTES = 3;

export function h3Work(request: H3SegmentRequest, constants: H3Constants = resolveH3Constants()): H3Work {
  const g = constants.geometry;
  const q = constants.qwen;
  const frames = alignedFrames(request.frames, g);
  const outputSeconds = frames / g.fps;
  const latentT = latentFrames(frames, g);
  const rows = rowsPerFrame(request.width, request.height, g);
  const targetRows = latentT * rows + audioRows(outputSeconds, g);
  const tokensOf = (width: number, height: number, minPixels: number, maxPixels: number, count = 1) => {
    const size = qwenResize(width, height, q.factor, minPixels, maxPixels, count, q.temporalPatch);
    return (size.width / q.factor) * (size.height / q.factor);
  };

  // A route may prepare reference pictures at another short edge (TE reference_image_short_edge)
  const imageGeometry = (request.referenceImageShortEdge != null && Boolean(request.referenceImageShortEdge)) ? { ...g, referenceImageShortEdge: request.referenceImageShortEdge } : g;
  let rejected = 0;
  let imageRows = 0;
  let imageTokens = 0;
  let imagePx = 0;
  for (const image of request.images ?? []) {
    const prepared = preparedImage(image.width, image.height, imageGeometry);
    if (!prepared) {
      rejected += 1;
      continue;
    }
    imageRows += rowsPerFrame(prepared.width, prepared.height, g);
    imageTokens += tokensOf(prepared.width, prepared.height, q.imageMinPixels, q.imageMaxPixels) + q.wrapTokens;
    imagePx += prepared.width * prepared.height;
  }

  let videoRows = 0;
  let videoAudioRows = 0;
  let videoTokens = 0;
  let videoPxFrames = 0;
  let audioSeconds = 0;
  const shortEdge = request.referenceVideoShortEdge ?? g.referenceVideoShortEdge;
  for (const video of request.videos ?? []) {
    const canvas = referenceVideoCanvas(video.width, video.height, shortEdge, g);
    if (!canvas) {
      rejected += 1;
      continue;
    }
    const usedFrames = Math.min(roundHalfEven(video.seconds * g.fps), frames);
    videoRows += latentFrames(usedFrames, g) * rowsPerFrame(canvas.width, canvas.height, g);
    const sampled = Math.ceil(usedFrames / (g.fps / q.sampleFps));
    const temporal = Math.ceil(sampled / q.temporalPatch);
    videoTokens += temporal * (tokensOf(canvas.width, canvas.height, q.videoMinPixels, q.videoMaxPixels, sampled) + q.wrapTokens);
    videoPxFrames += usedFrames * canvas.width * canvas.height;
    if (video.withAudio) {
      const seconds = Math.min(video.seconds, outputSeconds);
      videoAudioRows += audioRows(seconds, g);
      audioSeconds += seconds;
    }
  }

  let audioClipRows = 0;
  for (const audio of request.audios ?? []) {
    const seconds = Math.min(audio.seconds, outputSeconds);
    audioClipRows += audioRows(seconds, g);
    audioSeconds += seconds;
  }

  const keyframe = request.keyframe === true;
  const keyframeRows = keyframe ? rows : 0;
  const keyframeTokens = keyframe ? tokensOf(request.width, request.height, q.imageMinPixels, q.imageMaxPixels) + q.wrapTokens : 0;
  const keyframePx = keyframe ? request.width * request.height : 0;

  const text = request.text;
  const textTokens = "tokens" in text ? text.tokens : "text" in text ? approximateTextTokens(text.text) : Math.ceil(text.characters / 4);
  const textTokensEstimated = !("tokens" in text) || text.approximate === true;
  const conditioningTokens = textTokens + imageTokens + videoTokens + keyframeTokens;
  const usedRows = conditioningTokens + imageRows + videoRows + videoAudioRows + audioClipRows + keyframeRows + targetRows;
  const seq = Math.ceil(usedRows / constants.dit.rowAlign) * constants.dit.rowAlign;
  const ditFlopPerStep = { linear: constants.dit.flopsPerRow * seq, attention: constants.dit.flopsPerRowSquared * seq * seq };
  const steps = request.steps !== null && Number.isFinite(request.steps) && request.steps > 0 ? request.steps : null;
  const ditFlop = steps === null ? null : steps * (ditFlopPerStep.linear + ditFlopPerStep.attention);
  const teFlop = constants.te.flopsPerToken * conditioningTokens + constants.te.flopsPerTokenSquared * conditioningTokens * conditioningTokens;
  const px = { refImage: imagePx, refVideoFrames: videoPxFrames, keyframe: keyframePx, outputFrames: frames * request.width * request.height };

  const stage = (name: H3Stage, work: number | null): StageWork => ({ stage: name, work, unit: STAGE_UNITS[name] });
  const stages: StageWork[] = [stage("encode", teFlop)];
  if (px.refImage > 0) stages.push(stage("encode_image", px.refImage));
  if (px.refVideoFrames > 0) stages.push(stage("encode_video", px.refVideoFrames));
  if (px.keyframe > 0) stages.push(stage("encode_keyframe", px.keyframe));
  if (audioSeconds > 0) stages.push(stage("encode_audio", audioSeconds));
  // The used rows are the sum the provider records as its risk measure (runtimes/h3 denoise: cu_seqlens[1] = Qwen
  // tokens + reference rows + target rows, not padded). They are exact except for an approximate prompt length, whose
  // band the measure then carries.
  const risk: NonNullable<StageWork["risk"]> = { measure: usedRows, unit: ROW_RISK_UNIT };
  if (textTokensEstimated) {
    const others = usedRows - textTokens;
    risk.range = { low: others + Math.floor(textTokens * APPROX_TEXT_TOKEN_BAND.low), high: others + Math.ceil(textTokens * APPROX_TEXT_TOKEN_BAND.high) };
  }
  stages.push({ ...stage("denoise", ditFlop), risk });
  stages.push(stage("decode_video", px.outputFrames));
  stages.push(stage("decode_audio", outputSeconds));

  return {
    frames,
    latentFrames: latentT,
    rowsPerFrame: rows,
    targetRows,
    referenceRows: { image: imageRows, video: videoRows, videoAudio: videoAudioRows, audio: audioClipRows, keyframe: keyframeRows },
    qwenTokens: { text: textTokens, image: imageTokens, video: videoTokens, keyframe: keyframeTokens },
    textTokensEstimated,
    conditioningTokens,
    usedRows,
    seq,
    steps,
    ditFlopPerStep,
    ditFlop,
    teFlop,
    px,
    referenceAudioSeconds: audioSeconds,
    outputSeconds,
    bytes: {
      conditioning: conditioningTokens * constants.te.hidden * BF16_BYTES,
      preparedPayload: RGB_U8_BYTES * (px.refImage + px.refVideoFrames + px.keyframe) + F32_BYTES * g.audioChannels * Math.round(g.audioSampleRate * audioSeconds),
    },
    rejectedReferences: rejected,
    stages,
    constantsSource: constants.source,
  };
}
