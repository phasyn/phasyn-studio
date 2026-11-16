// Video Studio test scenarios (catalog, pipelines, takes); imported by *.test.ts only. Generic wire objects come from
// @/test/fixtures and ids from @/test/ids. The scenario mirrors the public example deployment: Node A holds the GPU
// components (GPU 0 and GPU 1), Node B a remote TE and a captioner on its unified-memory GPU.
import type { Asset, Catalog, ComponentDescriptor, StudioTake } from "@/api/generated/contracts";
import type { WirePipeline, WireStep } from "@/api/types";
import { catalog as wireCatalog, descriptor, port } from "@/test/fixtures";
import { FIXED_TIME, NODE_A_ID, NODE_A_LABEL, NODE_B_ID, NODE_B_LABEL, PIPELINE_ID, RESOURCE_GROUP, uid } from "@/test/ids";

export interface ComponentOptions {
  state?: ComponentDescriptor["state"];
  /** load.provider_options.variant (H3 checkpoint: fl2va / ref2va). */
  variant?: string;
  /** Saved invoke defaults. */
  invoke?: Record<string, unknown>;
  resourceGroup?: string;
  /** Component definition `limits` (for example `{ swap: {...} }`). */
  limits?: Record<string, unknown> | null;
  /** Component definition `exclusive_group` (the example deployment puts every DiT in "dit"). */
  exclusiveGroup?: string | null;
}

export function component(node_id: string, component_id: string, provider_id: string, options: ComponentOptions = {}): ComponentDescriptor {
  return descriptor(node_id, component_id, provider_id, {
    state: options.state ?? "ready",
    resourceGroup: options.resourceGroup ?? RESOURCE_GROUP.gpu0,
    providerOptions: options.variant ? { variant: options.variant } : {},
    invoke: options.invoke ?? {},
    limits: options.limits ?? null,
    exclusive_group: options.exclusiveGroup ?? (provider_id === "h3.dit" ? "dit" : null),
  });
}

/** Catalog with Node A and Node B (labels from the naming table); liveness defaults to online. */
export function catalog(nodeA: ComponentDescriptor[], nodeB: ComponentDescriptor[] = [], liveness: { a?: "online" | "offline"; b?: "online" | "offline" } = {}): Catalog {
  return wireCatalog(
    [...nodeA, ...nodeB],
    [
      { node_id: NODE_A_ID, label: NODE_A_LABEL, state: liveness.a ?? "online" },
      { node_id: NODE_B_ID, label: NODE_B_LABEL, state: liveness.b ?? "online" },
    ],
  );
}

/** The example deployment: H3 components on Node A (fl2va and ref2va DiTs), a remote TE and a captioner on Node B. */
export function exampleCatalog(overrides: Partial<Record<string, ComponentOptions>> = {}): Catalog {
  const c = (node: string, id: string, provider: string, base: ComponentOptions = {}) => component(node, id, provider, { ...base, ...overrides[id] });
  return catalog(
    [
      c(NODE_A_ID, "te-gpu0", "h3.conditioning", { variant: "fl2va" }),
      c(NODE_A_ID, "dit-fl2va-bf16-base", "h3.dit", { variant: "fl2va", invoke: { seed: 42, steps: 8, video_shift: 12, audio_shift: 3 } }),
      c(NODE_A_ID, "dit-ref2va-bf16-base", "h3.dit", { variant: "ref2va" }),
      c(NODE_A_ID, "ref-gpu0", "h3.reference", { variant: "fl2va" }),
      c(NODE_A_ID, "ref-r", "h3.reference", { variant: "ref2va" }),
      c(NODE_A_ID, "vae-gpu0", "h3.video_decode", { variant: "fl2va" }),
      c(NODE_A_ID, "audio-gpu1", "h3.audio_decode", { variant: "fl2va", resourceGroup: RESOURCE_GROUP.gpu1 }),
      c(NODE_A_ID, "mux", "media.mux", { resourceGroup: RESOURCE_GROUP.cpu }),
      c(NODE_A_ID, "frame", "media.frame", { resourceGroup: RESOURCE_GROUP.cpu }),
      c(NODE_A_ID, "concat", "media.concat", { resourceGroup: RESOURCE_GROUP.cpu }),
    ],
    [c(NODE_B_ID, "te-uma0", "h3.conditioning", { variant: "fl2va", resourceGroup: RESOURCE_GROUP.uma }), c(NODE_B_ID, "describe-uma0", "qwen_vl.describe", { resourceGroup: RESOURCE_GROUP.uma })],
  );
}

const step = (step_id: string, node_id: string, component_id: string, inputs: WireStep["inputs"], parameters: Record<string, unknown> = {}): WireStep => ({ step_id, node_id, component_id, inputs, parameters });

const decode = (dit: string): WireStep[] => [
  step("video", NODE_A_ID, "vae-gpu0", { latent: { from_step: dit, output: "video_latent" } }),
  step("audio", NODE_A_ID, "audio-gpu1", { latent: { from_step: dit, output: "audio_latent" } }),
  step("mux", NODE_A_ID, "mux", { video: { from_step: "video", output: "asset" }, audio: { from_step: "audio", output: "audio" } }),
];

/** t2va pipeline (TE on teNode; default: the remote TE on Node B). */
export function t2vaPipeline(pipeline_id: string = PIPELINE_ID.t2vaRemoteTe, teNode = NODE_B_ID, teComponent = "te-uma0", ditParameters: Record<string, unknown> = {}): WirePipeline {
  return {
    pipeline_id,
    label: `t2va：TE(${teComponent}) → DiT → VAE ‖ audio → mux`,
    inputs: [port("prompt", "text.prompt.v1")],
    steps: [
      step("te", teNode, teComponent, { prompt: { from_input: "prompt" } }),
      step(
        "dit",
        NODE_A_ID,
        "dit-fl2va-bf16-base",
        { conditioning: { from_step: "te", output: "conditioning" }, job: { from_step: "te", output: "job" }, prepared: { from_step: "te", output: "prepared" } },
        ditParameters,
      ),
      ...decode("dit"),
    ],
    outputs: { final: { from_step: "mux", output: "asset" }, video_latent: { from_step: "dit", output: "video_latent" } },
  };
}

/** fl2va: first-frame input → TE first_frame; reference encode → DiT references. */
export function fl2vaPipeline(pipeline_id: string = PIPELINE_ID.fl2va): WirePipeline {
  return {
    pipeline_id,
    label: "fl2va：首幀接續（Node A）",
    inputs: [port("prompt", "text.prompt.v1"), { ...port("first_frame", "media.image.v1"), transport: "file" }],
    steps: [
      step("te", NODE_A_ID, "te-gpu0", { prompt: { from_input: "prompt" }, first_frame: { from_input: "first_frame" } }),
      step("ref", NODE_A_ID, "ref-gpu0", { prepared: { from_step: "te", output: "prepared" }, job: { from_step: "te", output: "job" } }),
      step("dit", NODE_A_ID, "dit-fl2va-bf16-base", {
        conditioning: { from_step: "te", output: "conditioning" },
        job: { from_step: "te", output: "job" },
        prepared: { from_step: "te", output: "prepared" },
        references: { from_step: "ref", output: "references" },
      }),
      ...decode("dit"),
    ],
    outputs: { final: { from_step: "mux", output: "asset" } },
  };
}

/** ref2va: materials input → TE materials; the ref2va reference encode and DiT. */
export function ref2vaPipeline(pipeline_id: string = PIPELINE_ID.ref2va): WirePipeline {
  return {
    pipeline_id,
    label: "ref2va：參考素材（Node A）",
    inputs: [port("prompt", "text.prompt.v1"), port("materials", "h3.materials.v1")],
    steps: [
      step("te", NODE_A_ID, "te-gpu0", { prompt: { from_input: "prompt" }, materials: { from_input: "materials" } }),
      step("ref", NODE_A_ID, "ref-r", { prepared: { from_step: "te", output: "prepared" }, job: { from_step: "te", output: "job" } }),
      step("dit", NODE_A_ID, "dit-ref2va-bf16-base", {
        conditioning: { from_step: "te", output: "conditioning" },
        job: { from_step: "te", output: "job" },
        prepared: { from_step: "te", output: "prepared" },
        references: { from_step: "ref", output: "references" },
      }),
      ...decode("dit"),
    ],
    outputs: { final: { from_step: "mux", output: "asset" } },
  };
}

/**
 * Takes reference materials, but its DiT is an fl2va checkpoint (what a template draft looks like when it picked the wrong
 * DiT). No merged reference-encode step, so nothing else is wrong with it and it is ready.
 */
export function ref2vaOnFl2vaDit(pipeline_id: string): WirePipeline {
  const base = ref2vaPipeline(pipeline_id);
  return {
    ...base,
    steps: base.steps
      .filter((item) => item.step_id !== "ref")
      .map((item) => (item.step_id === "dit" ? { ...item, component_id: "dit-fl2va-bf16-base", inputs: Object.fromEntries(Object.entries(item.inputs).filter(([name]) => name !== "references")) } : item)),
  };
}

/** Not a Studio pipeline (no prompt input). */
export function describePipeline(): WirePipeline {
  return {
    pipeline_id: "semantics-describe",
    label: "影片反推語意",
    inputs: [port("video", "media.asset.v1")],
    steps: [step("describe", NODE_B_ID, "describe-uma0", { video: { from_input: "video" } })],
    outputs: { scene: { from_step: "describe", output: "scene" } },
  };
}

export function asset(frames = 124, width = 768, height = 448, fileId = uid(2002)): Asset {
  return {
    asset_id: `asset-${fileId}`,
    kind: "final",
    file: { node_id: NODE_A_ID, file_id: fileId, size_bytes: 10, sha256: "a".repeat(64), media_type: "video/mp4", metadata: {} },
    source_latent: null,
    frame_count: frames,
    fps: { num: 24, den: 1 },
    width,
    height,
    complete: true,
    actual_settings: {},
  };
}

export function take(partial: Partial<StudioTake> = {}): StudioTake {
  return {
    take_id: "ta",
    run_id: uid(3001),
    output_key: "final",
    created_at: FIXED_TIME,
    state: "succeeded",
    prompt: "cat",
    seed: 42,
    frames: 124,
    width: 768,
    height: 448,
    route: PIPELINE_ID.t2vaRemoteTe,
    steps: null,
    asset: asset(124),
    video_latent: null,
    error: null,
    timings_ms: {},
    ...partial,
  };
}
