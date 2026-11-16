// Contract-level builders for Studio documents (StudioProject, StudioShot, StudioTake, Asset). Feature-specific
// scenarios (routes, render plans, swap jobs) stay in the feature's own fixtures and build on these.
import type { Asset, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { FIXED_TIME, PIPELINE_ID, uid } from "../ids";
import { fileRef } from "./pipeline";

/** A complete final MP4 asset on Node A (default 124 frames, 768×448, 24 fps). */
export function mediaAsset(overrides: Partial<Asset> = {}): Asset {
  const fileId = overrides.file?.file_id ?? uid(2001);
  return {
    asset_id: `asset-${fileId}`,
    kind: "final",
    file: fileRef(fileId, { size_bytes: 10, sha256: "a".repeat(64), media_type: "video/mp4" }),
    source_latent: null,
    frame_count: 124,
    fps: { num: 24, den: 1 },
    width: 768,
    height: 448,
    complete: true,
    actual_settings: {},
    ...overrides,
  };
}

/** A succeeded take of the t2va pipeline with a complete asset. */
export function studioTake(overrides: Partial<StudioTake> = {}): StudioTake {
  return {
    take_id: "take-1",
    run_id: uid(1001),
    output_key: "final",
    created_at: FIXED_TIME,
    state: "succeeded",
    prompt: "a paper boat on a rainy street",
    seed: 42,
    frames: 124,
    width: 768,
    height: 448,
    route: PIPELINE_ID.t2va,
    steps: null,
    asset: mediaAsset(),
    video_latent: null,
    error: null,
    timings_ms: {},
    ...overrides,
  };
}

/** An enabled shot without takes, playing its whole length. */
export function studioShot(overrides: Partial<StudioShot> = {}): StudioShot {
  return {
    shot_id: "shot-1",
    title: "",
    prompt: "a paper boat on a rainy street",
    frames: 124,
    seed: 42,
    seed_locked: false,
    route: PIPELINE_ID.t2va,
    steps: null,
    video_shift: null,
    audio_shift: null,
    enabled: true,
    in_frame: 0,
    out_frame: null,
    takes: [],
    active_take_id: null,
    note: "",
    ...overrides,
  };
}

/** An empty project (768×448 at 24 fps, t2va default route); pass `shots`, `library`… to fill it. */
export function studioProject(overrides: Partial<StudioProject> = {}): StudioProject {
  return {
    project_id: "project-1",
    title: "Test project",
    revision: 1,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    format: { width: 768, height: 448, fps: { num: 24, den: 1 } },
    defaults: { frames: 124, route: PIPELINE_ID.t2va, steps: null },
    shots: [],
    exports: [],
    library: [],
    image_shots: [],
    ...overrides,
  };
}
