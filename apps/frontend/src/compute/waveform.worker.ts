import initialize, { aggregate_peaks } from "./generated/editor-kernel/editor_kernel.js";
import { PEAK_PROTOCOL, readRequest, type PeakReply, type PeakRequest } from "./waveformProtocol";

declare const self: DedicatedWorkerGlobalScope;
let used = false;
let initialization: Promise<unknown> | null = null;

async function run(request: PeakRequest): Promise<void> {
  const identity = { protocol: PEAK_PROTOCOL, requestId: request.requestId, generation: request.generation } as const;
  let reply: PeakReply;
  try {
    initialization ??= initialize({ module_or_path: new URL("./generated/editor-kernel/editor_kernel_bg.wasm", import.meta.url) });
    await initialization;
  } catch {
    self.postMessage({ ...identity, kind: "error", code: "INITIALIZATION_FAILED" } satisfies PeakReply);
    self.close();
    return;
  }
  try {
    // Bindgen copies input into Wasm and returns a detached-from-Wasm typed array.
    // The explicit copy below guarantees the response owns an ordinary ArrayBuffer.
    const peaks = new Float32Array(aggregate_peaks(request.samples, request.channels, request.buckets));
    reply = { ...identity, kind: "result", peaks };
    self.postMessage(reply, [peaks.buffer]);
  } catch (error) {
    const code = error === "INPUT_BOUNDS" || error === "NON_FINITE" ? error : "WORKER_FAILED";
    reply = { ...identity, kind: "error", code };
    self.postMessage(reply);
  } finally {
    // A decoded PCM job can grow the linear heap to 64 MiB. One-shot workers
    // release that heap on every outcome instead of retaining its high-water mark.
    self.close();
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const request = readRequest(event.data);
  if (!request || used) throw new Error("PROTOCOL_ERROR");
  used = true;
  void run(request);
};
self.onmessageerror = () => { throw new Error("PROTOCOL_ERROR"); };
