// The task layouts of the Edit workspace (Editing, Color, Effects, Audio, Captions and graphics): which panel docks
// on the right and which tabs the two left groups open on. The chosen layout is remembered per project and travels
// in the URL (?layout=); what the user opens, closes or selects inside a layout is remembered per layout.
import { AudioLines, Captions, Palette, Scissors, Sparkles, type LucideIcon } from "lucide-react";
import { useSearchParams } from "react-router";
import { t } from "@/i18n";
import { createPersistentStore } from "@/lib/persistentStore";

export type EditLayoutId = "edit" | "color" | "effects" | "audio" | "captions";
export type TopTabId = "source" | "controls" | "mixer";
export type BottomTabId = "project" | "effects" | "markers" | "captions" | "history";
export type DockId = "color" | "effects" | "mixer" | "text";

export interface LayoutState {
  topTab: TopTabId;
  bottomTab: BottomTabId;
  topOpen: boolean;
  bottomOpen: boolean;
  dockOpen: boolean;
}

export interface EditLayout {
  id: EditLayoutId;
  label: string;
  icon: LucideIcon;
  /** The panel in the right dock; null = no dock (Editing: the inspector is the Effect Controls tab beside Source). */
  dock: DockId | null;
  /** How the layout opens the first time. */
  initial: LayoutState;
}

const OPEN = { topOpen: true, bottomOpen: true, dockOpen: true };

export const EDIT_LAYOUTS: readonly EditLayout[] = [
  { id: "edit", label: t("剪輯"), icon: Scissors, dock: null, initial: { ...OPEN, topTab: "source", bottomTab: "project" } },
  { id: "color", label: t("色彩"), icon: Palette, dock: "color", initial: { ...OPEN, topOpen: false, topTab: "controls", bottomTab: "project" } },
  { id: "effects", label: t("效果"), icon: Sparkles, dock: "effects", initial: { ...OPEN, topTab: "controls", bottomTab: "project" } },
  { id: "audio", label: t("音訊"), icon: AudioLines, dock: "mixer", initial: { ...OPEN, topTab: "controls", bottomTab: "project" } },
  { id: "captions", label: t("字幕與圖形"), icon: Captions, dock: "text", initial: { ...OPEN, topTab: "source", bottomTab: "captions" } },
];

const LAYOUT_IDS = EDIT_LAYOUTS.map((layout) => layout.id);
const TOP_TABS: readonly string[] = ["source", "controls", "mixer"] satisfies TopTabId[];
const BOTTOM_TABS: readonly string[] = ["project", "effects", "markers", "captions", "history"] satisfies BottomTabId[];

function isLayoutId(value: unknown): value is EditLayoutId {
  return typeof value === "string" && (LAYOUT_IDS as readonly string[]).includes(value);
}

interface Stored {
  /** The layout each project was last opened in (bounded). */
  projects: Record<string, EditLayoutId>;
  layouts: Partial<Record<EditLayoutId, Partial<LayoutState>>>;
}

function parseState(raw: unknown): Partial<LayoutState> {
  if (typeof raw !== "object" || raw === null) return {};
  const entry = raw as Record<string, unknown>;
  const out: Partial<LayoutState> = {};
  if (typeof entry.topTab === "string" && TOP_TABS.includes(entry.topTab)) out.topTab = entry.topTab as TopTabId;
  if (typeof entry.bottomTab === "string" && BOTTOM_TABS.includes(entry.bottomTab)) out.bottomTab = entry.bottomTab as BottomTabId;
  if (typeof entry.topOpen === "boolean") out.topOpen = entry.topOpen;
  if (typeof entry.bottomOpen === "boolean") out.bottomOpen = entry.bottomOpen;
  if (typeof entry.dockOpen === "boolean") out.dockOpen = entry.dockOpen;
  return out;
}

const store = createPersistentStore<Stored>({
  key: "phasyn.studio.nle.layouts",
  initial: { projects: {}, layouts: {} },
  parse: (raw: unknown) => {
    const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const projects = typeof entry.projects === "object" && entry.projects !== null ? Object.entries(entry.projects as Record<string, unknown>) : [];
    const layouts = typeof entry.layouts === "object" && entry.layouts !== null ? (entry.layouts as Record<string, unknown>) : {};
    return {
      projects: Object.fromEntries(projects.filter((item): item is [string, EditLayoutId] => isLayoutId(item[1])).slice(-200)),
      layouts: Object.fromEntries(LAYOUT_IDS.map((id) => [id, parseState(layouts[id])])),
    };
  },
});

/** The current task layout: the URL's ?layout= when it names one, else the one this project was last opened in. */
export function useEditLayout(projectId: string): [EditLayout, (id: EditLayoutId) => void] {
  const [params, setParams] = useSearchParams();
  const stored = store.use();
  const requested = params.get("layout");
  const id = isLayoutId(requested) ? requested : (stored.projects[projectId] ?? "edit");
  const layout = EDIT_LAYOUTS.find((item) => item.id === id) ?? EDIT_LAYOUTS[0]!;
  const choose = (next: EditLayoutId) => {
    store.set((current) => {
      const { [projectId]: _previous, ...others } = current.projects;
      return { ...current, projects: { ...others, [projectId]: next } };
    });
    setParams(
      (current) => {
        const out = new URLSearchParams(current);
        out.set("layout", next);
        return out;
      },
      { replace: true },
    );
  };
  return [layout, choose];
}

/** What is open and selected inside a layout, with the layout's own defaults until the user changes something. */
export function useLayoutState(layout: EditLayout): [LayoutState, (patch: Partial<LayoutState>) => void] {
  const stored = store.use();
  const state = { ...layout.initial, ...stored.layouts[layout.id] };
  const update = (patch: Partial<LayoutState>) => store.set((current) => ({ ...current, layouts: { ...current.layouts, [layout.id]: { ...current.layouts[layout.id], ...patch } } }));
  return [state, update];
}
