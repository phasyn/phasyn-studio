// Stage names and work units of the ETA cost model, the same across the system: providers record exactly these in a
// recording's `cost.stages` (calls with the same stage name add up within one call), and the controller fits one time
// per unit for each (stage, work_unit). The estimator predicts the H3 stages; mux and concat are recorded by the CPU
// media components.
import type { CostProfileStage } from "@/api/generated/contracts";

/** flop, pixel, pixel_frame, second, byte, token or call (the contract's enum). */
export type WorkUnit = CostProfileStage["work_unit"];

export const WORK_UNITS: readonly WorkUnit[] = ["flop", "pixel", "pixel_frame", "second", "byte", "token", "call"];

export const STAGE_UNITS = {
  /** Text encoder over the S conditioning tokens. */
  encode: "flop",
  /** fl2va keyframe canvases, width × height each. */
  encode_keyframe: "pixel",
  /** ref2va reference images, prepared canvas. */
  encode_image: "pixel",
  /** Reference videos, frames × width × height. */
  encode_video: "pixel_frame",
  /** Reference audio clips and embedded soundtracks. */
  encode_audio: "second",
  /** DiT: steps × FLOPs of the packed sequence; its risk measure is the used rows. */
  denoise: "flop",
  /** Output frames × width × height. */
  decode_video: "pixel_frame",
  /** Output PCM. */
  decode_audio: "second",
  /** media.mux: bytes read (the decoded video and audio files). */
  mux: "byte",
  /** media.concat: output frames × width × height. */
  concat: "pixel_frame",
} as const satisfies Record<string, WorkUnit>;

export type CostStage = keyof typeof STAGE_UNITS;
export type H3Stage = Exclude<CostStage, "mux" | "concat">;

/** Unit of H3 denoise's risk measure (the used rows L): what out-of-memory limits are compared in. */
export const ROW_RISK_UNIT = "row";
