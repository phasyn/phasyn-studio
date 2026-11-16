// Track heights of the full timeline (S / M / L), remembered in this browser per project: one default for every track
// (the header's height menu) and per-track overrides (dragging a header's lower edge). The compact timeline is always S.
import { createPersistentStore } from "@/lib/persistentStore";
import { TRACK_SIZES, type TrackSize } from "../timelineGeometry";

interface StoredSizes {
  project: string;
  base: TrackSize;
  tracks: Record<string, TrackSize>;
}

const KEEP = 40;
const isSize = (value: unknown): value is TrackSize => typeof value === "string" && (TRACK_SIZES as readonly string[]).includes(value);

const store = createPersistentStore<StoredSizes[]>({
  key: "phasyn.studio.track-sizes",
  initial: [],
  parse: (raw: unknown) =>
    Array.isArray(raw)
      ? raw.flatMap((item): StoredSizes[] => {
          if (typeof item !== "object" || item === null) return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.project !== "string" || entry.project.length > 200 || !isSize(entry.base)) return [];
          const tracks = typeof entry.tracks === "object" && entry.tracks !== null ? Object.entries(entry.tracks as Record<string, unknown>) : [];
          return [{ project: entry.project, base: entry.base, tracks: Object.fromEntries(tracks.filter((pair): pair is [string, TrackSize] => isSize(pair[1])).slice(0, 32)) }];
        })
      : [],
});

export interface TrackSizes {
  base: TrackSize;
  of: (trackId: string) => TrackSize;
  /** One height for every track (clears the per-track overrides). */
  setBase: (size: TrackSize) => void;
  setTrack: (trackId: string, size: TrackSize) => void;
}

export function useTrackSizes(projectId: string): TrackSizes {
  const all = store.use();
  const current = all.find((item) => item.project === projectId) ?? { project: projectId, base: "m" as TrackSize, tracks: {} };
  const write = (next: StoredSizes) => store.set((items) => [...items.filter((item) => item.project !== projectId).slice(-(KEEP - 1)), next]);
  return {
    base: current.base,
    of: (trackId) => current.tracks[trackId] ?? current.base,
    setBase: (size) => write({ project: projectId, base: size, tracks: {} }),
    setTrack: (trackId, size) => write({ ...current, tracks: { ...current.tracks, [trackId]: size } }),
  };
}
