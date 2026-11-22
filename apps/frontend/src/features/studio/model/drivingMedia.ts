// Driving media of the 表演影片 and 音訊驅動 方式 (studio_creative routes): the character image, the performance video and
// the driving sound are the shot's first reference of each kind (@Image1, @Video1, @Audio1), so they live in the shot's
// existing references and need no field of their own. The References tab edits them as three named slots; the render
// plan sends them to the route's role inputs (StudioRoute.drivingInputs). Pure.
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { DRIVING_KIND, DRIVING_ROLES, type DrivingRole } from "./providerTraits";
import type { StudioRoute } from "./routes";

const ALIAS = /^(?:Image|Video|Audio)([1-9][0-9]?)$/u;
const PREFIX: Readonly<Record<StudioReference["kind"], string>> = { image: "Image", video: "Video", audio: "Audio" };

function ordinal(reference: StudioReference): number {
  const match = ALIAS.exec(reference.alias);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** The shot's first reference of a kind (lowest @ number); null when it has none. */
export function drivingReference(references: readonly StudioReference[], kind: StudioReference["kind"]): StudioReference | null {
  return [...references].filter((reference) => reference.kind === kind).sort((a, b) => ordinal(a) - ordinal(b))[0] ?? null;
}

/** The roles a route is driven by, in display order (character first). */
export function routeDrivingRoles(route: StudioRoute | null): DrivingRole[] {
  return route ? DRIVING_ROLES.filter((role) => route.drivingInputs[role] !== undefined) : [];
}

/** The library item chosen for a role on this shot, or null. */
export function drivingItem(references: readonly StudioReference[], library: readonly StudioLibraryItem[], role: DrivingRole): StudioLibraryItem | null {
  const reference = drivingReference(references, DRIVING_KIND[role]);
  return reference ? (library.find((item) => item.item_id === reference.item_id) ?? null) : null;
}

/**
 * The shot's references with `item` as the role's media: it replaces the first reference of that kind (keeping its @
 * name), is added as the next @ name when there is none, and null removes that first reference. Clip settings reset.
 */
export function withDrivingItem(references: readonly StudioReference[], role: DrivingRole, item: Pick<StudioLibraryItem, "item_id"> | null, refId: string): StudioReference[] {
  const kind = DRIVING_KIND[role];
  const current = drivingReference(references, kind);
  if (!item) return current ? references.filter((reference) => reference.ref_id !== current.ref_id) : [...references];
  if (current) return references.map((reference) => (reference.ref_id === current.ref_id ? { ...reference, item_id: item.item_id, start_seconds: null, end_seconds: null } : reference));
  const used = new Set(references.filter((reference) => reference.kind === kind).map(ordinal));
  let next = 1;
  while (used.has(next)) next += 1;
  const created: StudioReference = { ref_id: refId, kind, alias: `${PREFIX[kind]}${String(next)}`, item_id: item.item_id, start_seconds: null, end_seconds: null };
  return [...references, created];
}
