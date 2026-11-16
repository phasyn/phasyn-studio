// Shared test fixtures (import from "@/test/fixtures"). Feature-specific scenarios stay next to their tests;
// generic wire objects (descriptors, catalogs, pipelines, runs) come from here.
export { catalog, catalogLite, DEFAULT_NODES, descriptor, descriptorLite, device, directoryEntry, lookupFrom, nodeSnapshot } from "./catalog";
export type { DescriptorOptions, NodeSpec } from "./catalog";
export { fileRef, fromInput, fromStep, pipeline, run, step, stepRecord } from "./pipeline";
export type { PipelineOptions, RunOptions, StepRecord } from "./pipeline";
export { port, PROVIDER_PORTS, providerPorts } from "./ports";
export type { ProviderPorts } from "./ports";
export { mediaAsset, studioProject, studioShot, studioTake } from "./studio";
