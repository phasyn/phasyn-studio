/** Binary Worker contract. Bounds must match packages/editor-kernel/src/peaks.rs. */
export const PEAK_PROTOCOL = 1;
export const MAX_PCM_SAMPLES = 16_777_216;
export const MAX_PCM_CHANNELS = 8;
export const MAX_PEAK_BUCKETS = 4096;
export const PEAK_JOB_TIMEOUT_MS = 15_000;

export type PeakErrorCode = "INPUT_BOUNDS" | "NON_FINITE" | "INITIALIZATION_FAILED" | "WORKER_FAILED" | "PROTOCOL_ERROR" | "CANCELLED" | "TIMEOUT" | "MEDIA_FAILED";
export type PeakRequest = {
  protocol: typeof PEAK_PROTOCOL;
  requestId: number;
  generation: number;
  channels: number;
  buckets: number;
  samples: Float32Array<ArrayBuffer>;
};
export type PeakReply = {
  protocol: typeof PEAK_PROTOCOL;
  requestId: number;
  generation: number;
} & ({ kind: "result"; peaks: Float32Array<ArrayBuffer> } | { kind: "error"; code: PeakErrorCode });

export function validDimensions(samples: number, channels: number, buckets: number): boolean {
  return Number.isSafeInteger(samples) && samples > 0 && samples <= MAX_PCM_SAMPLES
    && Number.isSafeInteger(channels) && channels > 0 && channels <= MAX_PCM_CHANNELS
    && samples % channels === 0
    && Number.isSafeInteger(buckets) && buckets > 0 && buckets <= MAX_PEAK_BUCKETS;
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function readRequest(value: unknown): PeakRequest | null {
  const data = record(value);
  if (!data || data.protocol !== PEAK_PROTOCOL || !Number.isSafeInteger(data.requestId) || !Number.isSafeInteger(data.generation)
    || typeof data.requestId !== "number" || data.requestId <= 0 || typeof data.generation !== "number" || data.generation <= 0
    || typeof data.channels !== "number" || typeof data.buckets !== "number"
    || !(data.samples instanceof Float32Array) || !(data.samples.buffer instanceof ArrayBuffer)
    || !validDimensions(data.samples.length, data.channels, data.buckets)) return null;
  return { protocol: PEAK_PROTOCOL, requestId: data.requestId, generation: data.generation, channels: data.channels, buckets: data.buckets, samples: data.samples as Float32Array<ArrayBuffer> };
}

export function isPeakErrorCode(value: unknown): value is PeakErrorCode {
  return value === "INPUT_BOUNDS" || value === "NON_FINITE" || value === "INITIALIZATION_FAILED"
    || value === "WORKER_FAILED" || value === "PROTOCOL_ERROR" || value === "CANCELLED" || value === "TIMEOUT" || value === "MEDIA_FAILED";
}
