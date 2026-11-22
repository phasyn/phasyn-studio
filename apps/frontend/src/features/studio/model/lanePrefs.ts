// Which routes a project's batch render is spread over (model/lanes.ts): a per-browser choice. The split itself is
// written into the shots when a batch is sent, so the project document needs no field for it.
import { createPersistentStore } from "@/lib/persistentStore";
import { isRecord } from "@/lib/json";

/** Projects remembered; the oldest choice is dropped first. */
const MAX_PROJECTS = 50;
const NO_LANES: readonly string[] = [];

type LanePrefs = Readonly<Record<string, readonly string[]>>;

function parse(raw: unknown): LanePrefs {
  if (!isRecord(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [projectId, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.every((item): item is string => typeof item === "string" && item.length > 0)) out[projectId] = value;
  }
  return out;
}

const lanePrefs = createPersistentStore<LanePrefs>({ key: "phasyn.studio.lanes", initial: {}, parse });

/** The lane routes chosen for this project in this browser; empty = the batch is not spread. */
export function useProjectLanes(projectId: string): readonly string[] {
  return lanePrefs.use()[projectId] ?? NO_LANES;
}

export function setProjectLanes(projectId: string, laneIds: readonly string[]): void {
  lanePrefs.set((current) => {
    const { [projectId]: _prior, ...others } = current;
    const next = laneIds.length > 0 ? { ...others, [projectId]: [...laneIds] } : others;
    return Object.fromEntries(Object.entries(next).slice(-MAX_PROJECTS));
  });
}
