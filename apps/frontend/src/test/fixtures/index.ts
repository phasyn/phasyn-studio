import { isRecord } from "@/lib/json";
import fullContract from "@contracts/component.schema.json";
import type { PhasynStudioContracts } from "@/api/generated/contracts";
import { matchesReply } from "@/api/http";
// Shared test fixtures (import from "@/test/fixtures"). Feature-specific scenarios stay next to their tests;
// generic wire objects (descriptors, catalogs, pipelines, runs) come from here.
export { catalog, catalogLite, DEFAULT_NODES, descriptor, descriptorLite, device, directoryEntry, lookupFrom, nodeSnapshot } from "./catalog";
export type { DescriptorOptions, NodeSpec } from "./catalog";
export { fileRef, fromInput, fromStep, pipeline, run, step, stepRecord } from "./pipeline";
export type { PipelineOptions, RunOptions, StepRecord } from "./pipeline";
export { port, PROVIDER_PORTS, providerPorts } from "./ports";
export type { ProviderPorts } from "./ports";
export { mediaAsset, studioProject, studioShot, studioTake } from "./studio";

/** Retrieve an object a boundary fixture must contain; name the failing fixture instead of proceeding with undefined. */
export function fixtureValue<T>(value: T | null | undefined, location: string): T {
  if (value == null) throw new Error(`Missing fixture value in ${location}`);
  return value;
}

/** Required clock fields for synthetic autosave documents. */
export function fixtureRevision(candidate: Record<string, unknown>) {
  const { revision, created_at, updated_at } = candidate;
  if (typeof revision !== "number" || typeof created_at !== "string" || typeof updated_at !== "string") throw new TypeError("Invalid test document revision");
  return { revision, created_at, updated_at };
}

export function fixtureProject(candidate: unknown) {
  if (!isRecord(candidate)) throw new TypeError("Invalid test project");
  const { project_id, title, value } = candidate;
  if (typeof project_id !== "string" || typeof title !== "string" || typeof value !== "number") throw new TypeError("Invalid test project fields");
  return { ...fixtureRevision(candidate), project_id, title, value };
}

/** Shared provider fixtures travel through the same contract boundary as a native Controller response. */
export function contractFixture<K extends keyof PhasynStudioContracts>(name: K, value: unknown): Required<PhasynStudioContracts>[K] {
  if (!matchesReply(value, name, fullContract.$defs)) throw new TypeError("Invalid "+name+" fixture");
  return value;
}
