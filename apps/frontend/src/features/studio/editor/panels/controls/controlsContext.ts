// What the fields and groups of the property panels share without passing it through every row: the density of the
// panel they stand in, the reason nothing can be edited (a locked track), and which groups of Effect Controls are
// open. The open groups are remembered in this browser, per kind of clip.
import { createContext } from "react";
import { createPersistentStore } from "@/lib/persistentStore";

/** compact = Effect Controls (26 px fields, 30 px rows); comfortable = the docks (32 px fields). */
export type Density = "compact" | "comfortable";
export const DensityContext = createContext<Density>("compact");

/** Why the fields are read-only; null when they can be edited. */
export const FieldLockContext = createContext<string | null>(null);

export type GroupId = "clip" | "motion" | "opacity" | "time" | "fade" | "camera" | "impact" | "speedfeel" | "mask" | "effects" | "color" | "audio" | "text" | "animation";
/** What is selected: a clip on a video track, a clip on an audio track, a text layer or an adjustment layer. */
export type ClipKindId = "video" | "audio" | "text" | "adjustment";

const GROUP_IDS: readonly string[] = ["clip", "motion", "opacity", "time", "fade", "camera", "impact", "speedfeel", "mask", "effects", "color", "audio", "text", "animation"] satisfies GroupId[];

/** The first groups of each kind of clip start open (a text layer's text, its animation and the clip; an adjustment layer's effects). */
const DEFAULT_OPEN: Record<ClipKindId, GroupId[]> = { video: ["clip", "motion"], audio: ["clip", "audio"], text: ["text", "animation", "clip"], adjustment: ["effects", "opacity"] };

function parseGroups(raw: unknown, fallback: GroupId[]): GroupId[] {
  return Array.isArray(raw) ? raw.filter((item): item is GroupId => typeof item === "string" && GROUP_IDS.includes(item)) : fallback;
}

const openGroups = createPersistentStore<Record<ClipKindId, GroupId[]>>({
  key: "phasyn.studio.nle.controls.groups",
  initial: DEFAULT_OPEN,
  parse: (raw) => {
    const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      video: parseGroups(entry.video, DEFAULT_OPEN.video),
      audio: parseGroups(entry.audio, DEFAULT_OPEN.audio),
      text: parseGroups(entry.text, DEFAULT_OPEN.text),
      adjustment: parseGroups(entry.adjustment, DEFAULT_OPEN.adjustment),
    };
  },
});

/** Opens or closes a group for one kind of clip. */
export function setGroupOpen(kind: ClipKindId, id: GroupId, open: boolean): void {
  openGroups.set((current) => {
    const others = current[kind].filter((item) => item !== id);
    return { ...current, [kind]: open ? [...others, id] : others };
  });
}

/** The open groups of one kind of clip. */
export function useOpenGroups(kind: ClipKindId): readonly GroupId[] {
  return openGroups.use()[kind];
}

export interface GroupsState {
  open: readonly GroupId[];
  /** A group a command asked for (rename, speed): shown open until the request is taken. */
  forced: GroupId | null;
  setOpen: (id: GroupId, open: boolean) => void;
}

export const GroupsContext = createContext<GroupsState>({ open: [], forced: null, setOpen: () => undefined });
