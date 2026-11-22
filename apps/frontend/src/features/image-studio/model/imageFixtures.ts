// Image Studio test scenarios (Qwen-Image components, image pipelines, library items, runs); imported by *.test.ts
// only. Generic wire objects come from @/test/fixtures and ids from @/test/ids. Ports and parameter schemas follow the
// qimg providers and the public example pipelines t2i-local / i2i-local.
import type { Catalog, ComponentDescriptor } from "@/api/generated/contracts";
import type { WirePipeline, WireRun, WireStep } from "@/api/types";
import { catalog as wireCatalog, descriptor, port } from "@/test/fixtures";
import { FIXED_TIME, NODE_A_ID, PIPELINE_ID, RESOURCE_GROUP, uid } from "@/test/ids";
import type { ImageAsset, ImageLibraryItem, ImageStudioProject, StudioImageShot } from "../types";
import { newImageShot } from "./shots";

const image = (name: string, required = false) => port(name, "media.image.v1", required, "file");

/** Parameter names each provider declares (the schema closes additional properties). */
const SCHEMAS: Record<string, string[]> = {
  "qimg.prepare": ["width", "height", "reference_resolution", "base_index", "mask_invert"],
  "qimg.conditioning": ["cfg"],
  "qimg.vae_encode": ["tiling"],
  "qimg.dit": ["width", "height", "steps", "guidance", "sigma_schedule", "flow_shift_mu", "seed", "preview"],
  "qimg.vae_decode": ["mode"],
  "image.compose": ["metadata"],
};

export interface ComponentOptions {
  state?: ComponentDescriptor["state"];
  /** provider_options (variant, preview_vae, adapters…). */
  options?: Record<string, unknown>;
  /** load.offload (qimg.dit placement: { mode: "phase" | "group_stream" | "none" | "gguf_phase" }). */
  offload?: Record<string, unknown>;
  /** Parameter names of the schema (null = no schema). */
  params?: string[] | null;
  resourceGroup?: string;
  exclusiveGroup?: string | null;
}

export function component(node_id: string, component_id: string, provider_id: string, opts: ComponentOptions = {}): ComponentDescriptor {
  const params = opts.params === undefined ? (SCHEMAS[provider_id] ?? []) : opts.params;
  return descriptor(node_id, component_id, provider_id, {
    state: opts.state ?? "ready",
    resourceGroup: opts.resourceGroup ?? RESOURCE_GROUP.gpu0,
    providerOptions: opts.options ?? {},
    ...(opts.offload === undefined ? {} : { offload: opts.offload }),
    exclusive_group: opts.exclusiveGroup ?? null,
    parametersSchema: params === null ? {} : { type: "object", properties: Object.fromEntries(params.map((name) => [name, {}])), additionalProperties: false },
  });
}

/** Catalog of Node A and Node B holding the given components. */
export function catalog(components: ComponentDescriptor[]): Catalog {
  return wireCatalog(components);
}

/** A set of Qwen-Image components on Node A (a BF16 and a GGUF DiT, both in the "dit" exclusive group). */
export function qimgComponents(overrides: Partial<Record<string, ComponentOptions>> = {}): ComponentDescriptor[] {
  const make = (id: string, provider: string, defaults: ComponentOptions = {}) => component(NODE_A_ID, id, provider, { ...defaults, ...overrides[id] });
  return [
    make("qimg-prepare", "qimg.prepare"),
    make("qimg-te-gpu0", "qimg.conditioning"),
    make("qimg-venc-gpu0", "qimg.vae_encode"),
    make("qimg-dit-bf16-phase-gpu0", "qimg.dit", { options: { variant: "bf16", preview_vae: true }, offload: { mode: "phase" }, exclusiveGroup: "dit" }),
    make("qimg-dit-gguf", "qimg.dit", { options: { variant: "gguf_q4km" }, offload: { mode: "gguf_phase" }, exclusiveGroup: "dit" }),
    make("qimg-vae-gpu0", "qimg.vae_decode"),
    make("image-compose", "image.compose"),
  ];
}

/** The BF16 DiT of qimgComponents(). */
export const BF16_DIT = "qimg-dit-bf16-phase-gpu0";

const step = (step_id: string, component_id: string, inputs: WireStep["inputs"], parameters: Record<string, unknown> = {}, node_id = NODE_A_ID): WireStep => ({ step_id, node_id, component_id, inputs, parameters });

export function t2iPipeline(id: string = PIPELINE_ID.t2i, dit = BF16_DIT): WirePipeline {
  return {
    pipeline_id: id,
    label: `${id}：TE → DiT → VAE → compose`,
    inputs: [port("prompt", "text.prompt.v1"), port("negative_prompt", "text.prompt.v1", false)],
    steps: [
      step("te", "qimg-te-gpu0", { prompt: { from_input: "prompt" }, negative_prompt: { from_input: "negative_prompt" } }, { cfg: false }),
      step("dit", dit, { conditioning: { from_step: "te", output: "conditioning" } }, { width: 1024, height: 1024, steps: 40, guidance: 1, seed: 42 }),
      step("vae", "qimg-vae-gpu0", { latent: { from_step: "dit", output: "latent" } }, { mode: "full" }),
      step("compose", "image-compose", { image: { from_step: "vae", output: "image" } }),
    ],
    outputs: { image: { from_step: "compose", output: "image" }, image_white: { from_step: "compose", output: "image_white" } },
  };
}

/** i2i-local: the references are one inline list input (qimg.references.v1); the mask is a file input. */
export function i2iPipeline(id: string = PIPELINE_ID.i2i, dit = BF16_DIT): WirePipeline {
  return {
    pipeline_id: id,
    label: `${id}：prepare → TE ‖ venc → DiT → VAE → compose`,
    inputs: [port("prompt", "text.prompt.v1"), port("negative_prompt", "text.prompt.v1", false), port("references", "qimg.references.v1", true, "inline"), image("mask")],
    steps: [
      step("prepare", "qimg-prepare", { references: { from_input: "references" }, mask: { from_input: "mask" } }, { width: 1024, height: 1024, reference_resolution: 1024, base_index: 0, mask_invert: false }),
      step("te", "qimg-te-gpu0", { prompt: { from_input: "prompt" }, negative_prompt: { from_input: "negative_prompt" }, prepared: { from_step: "prepare", output: "prepared" } }, { cfg: false }),
      step("venc", "qimg-venc-gpu0", { prepared: { from_step: "prepare", output: "prepared" } }, { tiling: false }),
      step("dit", dit, { conditioning: { from_step: "te", output: "conditioning" }, ref_latents: { from_step: "venc", output: "ref_latents" } }, { width: 1024, height: 1024, steps: 40, guidance: 1, seed: 42 }),
      step("vae", "qimg-vae-gpu0", { latent: { from_step: "dit", output: "latent" } }, { mode: "full" }),
      step("compose", "image-compose", { image: { from_step: "vae", output: "image" }, prepared: { from_step: "prepare", output: "prepared" } }),
    ],
    outputs: { image: { from_step: "compose", output: "image" }, image_white: { from_step: "compose", output: "image_white" } },
  };
}

export function libraryImage(item_id: string, overrides: Partial<ImageLibraryItem> = {}): ImageLibraryItem {
  return {
    item_id,
    kind: "image",
    name: `${item_id}.png`,
    file: { node_id: NODE_A_ID, file_id: `file-${item_id}`, size_bytes: 10, sha256: "a".repeat(64), media_type: "image/png", metadata: {} },
    created_at: FIXED_TIME,
    duration_seconds: null,
    width: 1024,
    height: 1024,
    has_audio: false,
    ...overrides,
  };
}

export function imageAsset(asset_id: string, white = false): ImageAsset {
  return {
    asset_id,
    file: { node_id: NODE_A_ID, file_id: `png-${asset_id}`, size_bytes: 100, sha256: "c".repeat(64), media_type: "image/png", metadata: {} },
    width: 1024,
    height: 1024,
    mode: white ? "RGB" : "RGBA",
    has_alpha: !white,
    white_matte: white,
    source_take: null,
    actual_settings: {},
  };
}

export function project(shots: (Partial<StudioImageShot> & { image_shot_id: string })[] = [], library: ImageLibraryItem[] = []): ImageStudioProject {
  let doc: ImageStudioProject = {
    project_id: "p1",
    title: "測試專案",
    revision: 3,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    format: { width: 768, height: 448, fps: { num: 24, den: 1 } },
    defaults: { frames: 124, route: PIPELINE_ID.t2va, steps: null },
    shots: [],
    exports: [],
    library,
    image_shots: [],
  };
  for (const patch of shots) doc = { ...doc, image_shots: [...(doc.image_shots ?? []), newImageShot(doc, { prompt: "a cat", route: PIPELINE_ID.t2i, ...patch })] };
  return doc;
}

/** Run id of run(). */
export const RUN_ID = uid(3101);

/** A run with only the fields the read-back needs. steps: step id → state and other fields. */
export function run(request: WireRun["request"], steps: Record<string, Record<string, unknown>>, state: WireRun["state"] = "running"): WireRun {
  return {
    run_id: RUN_ID,
    state,
    request,
    created_at: FIXED_TIME,
    finished_at: state === "running" ? null : FIXED_TIME,
    steps,
    outputs: {},
    recording_ids: [],
    error: null,
  };
}
