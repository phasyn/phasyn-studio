// Synthetic identifiers shared by every frontend test (the repository-wide naming table).
// Tests never use real UUIDs, hostnames, addresses or hardware models: import these instead.
// Mirrors the backend module `phasyn_components.testing.ids` (same prefix, constants and serial format).

const UUID_PREFIX = "00000000-0000-4000-8000-";

/** Formats a 12-digit serial; decimal digits are valid hex, so `serial(1001)` → `000000001001`. */
function serial(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) throw new RangeError(`synthetic id serial out of range: ${value}`);
  return String(value).padStart(12, "0");
}

export const CONTROLLER_ID = `${UUID_PREFIX}0000000000c1`;
export const NODE_A_ID = `${UUID_PREFIX}0000000000a1`;
export const NODE_B_ID = `${UUID_PREFIX}0000000000b1`;
/** A third Node, for the rare test that needs one. */
export const NODE_C_ID = `${UUID_PREFIX}0000000000a2`;

/** Node labels as the UI shows them. */
export const NODE_A_LABEL = "Node A（GPU 0 + GPU 1）";
export const NODE_B_LABEL = "Node B（統一記憶體 GPU）";
export const NODE_LABELS: Readonly<Record<string, string>> = { [NODE_A_ID]: NODE_A_LABEL, [NODE_B_ID]: NODE_B_LABEL };

/** Node label / id fragments (`node-a`, `node-b`) for slugs, route segments and config ids. */
export const NODE_A_SLUG = "node-a";
export const NODE_B_SLUG = "node-b";

/** Any other id (run, call, recording, file, project…): `uid(1001)` → `00000000-0000-4000-8000-000000001001`. */
export function uid(value: number): string {
  return `${UUID_PREFIX}${serial(value)}`;
}

/** The 8-character abbreviation the UI shows (always the first 8 characters of the synthetic value). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Test GPU UUID: `gpuUuid(1)` → `GPU-00000000-0000-4000-8000-000000000001`. */
export function gpuUuid(index: number): string {
  return `GPU-${uid(index)}`;
}

/** Resource groups: two discrete GPUs on Node A, one unified-memory GPU on Node B. */
export const RESOURCE_GROUP = { gpu0: "gpu-0", gpu1: "gpu-1", uma: "gpu-uma", cpu: "cpu" } as const;

/** Component-pipeline ids used by the public deploy examples. */
export const PIPELINE_ID = {
  t2va: "t2va-local",
  fl2va: "fl2va-local",
  ref2va: "ref2va-local",
  t2vaRemoteTe: "t2va-remote-te",
  t2i: "t2i-local",
  i2i: "i2i-local",
  ref2vaRef448: "ref2va-local-ref448",
} as const;

/** Fixed timestamp for fixtures that need one (UTC). */
export const FIXED_TIME = "2026-01-01T00:00:00.000Z";

/** RFC 5737 documentation addresses for node endpoints: `nodeEndpoint(1)` → `http://192.0.2.1:8090`. */
export function nodeEndpoint(host: number, port = 8090): string {
  if (!Number.isInteger(host) || host < 1 || host > 254) throw new RangeError(`192.0.2.x host must be 1–254: ${host}`);
  return `http://192.0.2.${host}:${port}`;
}
