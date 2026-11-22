// What Studio knows about the model family behind a route, read from what the components themselves declare instead of
// assumed for every route. A route is one of:
//   - "h3": MiniMax H3 steps (h3.conditioning → h3.dit …). Only these carry the H3 rules: 24 fps (or the DiT's
//     facts.cost_model.fps), frames aligned to 17n+5 within 96–360, 4–15 s, the prompt advisor and the online API's
//     7000-character note.
//   - "declared": a producer that declares `facts.studio_generation` (for example Wan text / first-frame generation):
//     its frames, fps and sampling limits come from its own parameter schema (studioGenerationBinding.ts).
//   - "creative": a producer that declares only `facts.studio_creative` (for example Wan Animate and Wan S2V): it is
//     driven by media roles (character_image, performance_video, source_audio) instead of a duration.
//   - "edit": a producer that declares `facts.studio_edit` (Wan VACE extend / retake / control): these routes serve the
//     edit tools on an existing take and are not rendered from a shot's 方式.
//   - "other": anything else (the route then shows why it cannot render).
// A route's purpose (參考生成, 首幀, 文字, 延展, 重繪, 控制, 表演驅動, 音訊驅動) follows from the same facts and wiring, so
// the route picker groups routes by what they do. Pure; no requests.
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { namesExperiment } from "@/lib/experimental";
import { isRecord } from "@/lib/json";

export type ProviderFamily = "h3" | "declared" | "creative" | "edit" | "other";

export type RoutePurpose = "reference" | "first-frame" | "text" | "extend" | "retouch" | "control" | "performance" | "audio";

/** The order the route picker lists the purposes (then the experimental group). */
export const PURPOSE_ORDER: readonly RoutePurpose[] = ["reference", "first-frame", "text", "extend", "retouch", "control", "performance", "audio"];

/** Purposes a shot renders from its 方式; the others belong to the edit tools on an existing take. */
export const SHOT_PURPOSES: ReadonlySet<RoutePurpose> = new Set(["reference", "first-frame", "text", "performance", "audio"]);

/** The media roles a `studio_creative` producer can be driven by (contracts StudioCreativeMediaBindings). */
export type DrivingRole = "character_image" | "performance_video" | "source_audio";
export const DRIVING_ROLES: readonly DrivingRole[] = ["character_image", "performance_video", "source_audio"];
export const DRIVING_KIND: Readonly<Record<DrivingRole, "image" | "video" | "audio">> = { character_image: "image", performance_video: "video", source_audio: "audio" };
export const DRIVING_TYPE: Readonly<Record<DrivingRole, string>> = { character_image: "media.image.v1", performance_video: "media.video.v1", source_audio: "media.audio.v1" };

// ---------------------------------------------------------------- H3

/** H3 providers whose parameters Studio overrides (TE, DiT, reference encode); a declared producer may not be mixed with them. */
export const H3_STUDIO_PROVIDERS: ReadonlySet<string> = new Set(["h3.conditioning", "h3.dit", "h3.reference"]);

export function isH3Provider(providerId: string | null | undefined): boolean {
  return typeof providerId === "string" && providerId.startsWith("h3.");
}

/**
 * H3 time and length rules (runtimes/h3 geometry, SGLang minimax_h3 constants). The DiT's facts.cost_model may report
 * fps, frame_group and frame_offset; the rest are runtime limits that no component reports yet.
 */
export interface H3Rules {
  fps: number;
  frameGroup: number;
  frameOffset: number;
  minFrames: number;
  maxFrames: number;
  minSeconds: number;
  maxSeconds: number;
  /** MiniMax's online API limit per text (Studio's own limit is the 16384-character prompt field). */
  apiPromptCharacters: number;
}

export const H3_RULES: H3Rules = { fps: 24, frameGroup: 17, frameOffset: 5, minFrames: 96, maxFrames: 360, minSeconds: 4, maxSeconds: 15, apiPromptCharacters: 7000 };

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The H3 rules with what the DiT component reports in facts.cost_model (fps, frame_group, frame_offset) taking precedence. */
export function h3Rules(facts: unknown): H3Rules {
  const model = isRecord(facts) && isRecord(facts["cost_model"]) ? facts["cost_model"] : null;
  if (!model) return H3_RULES;
  return {
    ...H3_RULES,
    fps: positiveInteger(model["fps"]) ?? H3_RULES.fps,
    frameGroup: positiveInteger(model["frame_group"]) ?? H3_RULES.frameGroup,
    frameOffset: positiveInteger(model["frame_offset"]) ?? H3_RULES.frameOffset,
  };
}

// ---------------------------------------------------------------- facts

type Facts = ComponentDescriptor["facts"] | undefined;

function fact(facts: Facts, key: string): Record<string, unknown> | null {
  if (!isRecord(facts)) return null;
  const value = facts[key];
  return isRecord(value) && value["version"] === 1 ? value : null;
}

/** The component declares how Studio generates with it (studio_generation, studio_creative or studio_edit). */
export function declaresGenerator(facts: Facts): boolean {
  return fact(facts, "studio_generation") !== null || fact(facts, "studio_creative") !== null || fact(facts, "studio_edit") !== null;
}

export interface CreativeDeclaration {
  /** Semantic role → the component's input port. */
  roles: ReadonlyMap<string, string>;
  /** The component output that holds the published video (media.asset.v1). */
  output: string;
}

/** A `studio_creative` v1 video producer, or null. */
export function creativeDeclaration(component: ComponentDescriptor | null | undefined): CreativeDeclaration | null {
  const spec = fact(component?.facts, "studio_creative");
  if (!component || spec?.["medium"] !== "video" || !isRecord(spec["inputs"]) || typeof spec["output"] !== "string") return null;
  const output = spec["output"];
  if (!component.outputs.some((port) => port.name === output && port.type_id === "media.asset.v1")) return null;
  const roles = new Map<string, string>();
  for (const [role, port] of Object.entries(spec["inputs"])) if (typeof port === "string") roles.set(role, port);
  return { roles, output };
}

/** The purpose of a creative producer from its roles: a performance video wins, then a driving audio; null otherwise. */
export function creativePurpose(roles: ReadonlyMap<string, unknown>): RoutePurpose | null {
  if (roles.has("performance_video")) return "performance";
  if (roles.has("source_audio")) return "audio";
  return null;
}

/**
 * The purpose of a `studio_edit` producer as wired in a combination: its selector parameter (facts.studio_edit.selector)
 * names an operation; the declared operations are retakes (重繪) and extensions or gaps (延展); any other value of the
 * selector (control video, layout) conditions a new picture on a guide (控制). Null when the step is not an edit producer.
 */
export function editPurpose(component: ComponentDescriptor | null | undefined, parameters: Readonly<Record<string, unknown>>): RoutePurpose | null {
  const spec = fact(component?.facts, "studio_edit");
  if (!spec) return null;
  const selector = typeof spec["selector"] === "string" ? spec["selector"] : null;
  const value = selector === null ? undefined : parameters[selector];
  const operations = isRecord(spec["operations"]) ? spec["operations"] : {};
  const operation = Object.entries(operations).find(([, item]) => isRecord(item) && item["value"] === value)?.[0];
  if (operation === undefined) return "control";
  if (operation.includes("retake")) return "retouch";
  return "extend";
}

/**
 * A route the owner set up as an experiment or research variant: its name says so, or its DiT runs fewer steps than the
 * quality floor (the route's caveat). These are listed collapsed in their own group.
 */
export function isExperimental(label: string, hasCaveat: boolean): boolean {
  return hasCaveat || namesExperiment(label);
}

// ---------------------------------------------------------------- prompt and duration rules

export interface PromptRules {
  /** The H3 prompt advisor (sections, labels, timeline, wording) applies. */
  h3: boolean;
  /** Seconds per frame for durations: the H3 rule, or the project's frame rate on other routes. */
  fps: number;
  /** Frame range the route accepts (H3: 96–360; declared: from its schema); null when the route takes its length from media. */
  frames: { min: number; max: number } | null;
  /** H3 only: the online API's character note. */
  apiPromptCharacters: number | null;
}

export const DEFAULT_PROMPT_RULES: PromptRules = { h3: true, fps: H3_RULES.fps, frames: { min: H3_RULES.minFrames, max: H3_RULES.maxFrames }, apiPromptCharacters: H3_RULES.apiPromptCharacters };
