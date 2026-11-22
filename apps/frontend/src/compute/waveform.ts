import { PEAK_JOB_TIMEOUT_MS, PEAK_PROTOCOL, isPeakErrorCode, isPeakRecord, isOwnedPcm, validDimensions, type PeakErrorCode, type PeakRequest } from "./waveformProtocol";

export class WaveformError extends Error {
  readonly code: PeakErrorCode;

  constructor(code: PeakErrorCode) {
    super(code);
    this.code = code;
    this.name = "WaveformError";
  }
}

let generation = 0;
const active = new Set<() => void>();

/**
 * Consume an owned planar PCM buffer. A full view is transferred and detached;
 * a subview is copied using its offset/length, leaving unrelated caller data intact.
 * No SharedArrayBuffer or Wasm memory view enters UI state. There is no JS fallback.
 */
export function aggregateWaveform(samples: Float32Array<ArrayBuffer>, channels: number, buckets: number, signal?: AbortSignal): Promise<Float32Array<ArrayBuffer>> {
  if (!(samples.buffer instanceof ArrayBuffer) || !validDimensions(samples.length, channels, buckets)) return Promise.reject(new WaveformError("INPUT_BOUNDS"));
  if (signal?.aborted === true) return Promise.reject(new WaveformError("CANCELLED"));
  generation = generation % Number.MAX_SAFE_INTEGER + 1;
  const owner = generation;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./waveform.worker.ts", import.meta.url), { type: "module", name: "phasyn-waveform" });
    } catch {
      reject(new WaveformError("INITIALIZATION_FAILED"));
      return;
    }
    let settled = false;
    const finish = (result: Float32Array<ArrayBuffer> | WaveformError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      active.delete(cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (result instanceof WaveformError) reject(result);
      else resolve(result);
    };
    const cancel = () => { finish(new WaveformError("CANCELLED")); };
    active.add(cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new WaveformError("WORKER_FAILED")); };
    worker.onmessageerror = () => { finish(new WaveformError("PROTOCOL_ERROR")); };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!isPeakRecord(data) || data["protocol"] !== PEAK_PROTOCOL || data["requestId"] !== 1 || data["generation"] !== owner) {
        finish(new WaveformError("PROTOCOL_ERROR"));
      } else if (data["kind"] === "error" && isPeakErrorCode(data["code"])) {
        finish(new WaveformError(data["code"]));
      } else if (data["kind"] === "result" && isOwnedPcm(data["peaks"])
        && data["peaks"].length === buckets && data["peaks"].every((value) => Number.isFinite(value) && value >= 0)) {
        finish(data["peaks"]);
      } else {
        finish(new WaveformError("PROTOCOL_ERROR"));
      }
    };
    const timer = setTimeout(() => { finish(new WaveformError("TIMEOUT")); }, PEAK_JOB_TIMEOUT_MS);
    try {
      const owned = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength ? samples : new Float32Array(samples);
      worker.postMessage({ protocol: PEAK_PROTOCOL, requestId: 1, generation: owner, channels, buckets, samples: owned } satisfies PeakRequest, [owned.buffer]);
    } catch {
      finish(new WaveformError("WORKER_FAILED"));
    }
  });
}

if (import.meta.hot) import.meta.hot.dispose(() => { for (const cancel of active) cancel(); });
