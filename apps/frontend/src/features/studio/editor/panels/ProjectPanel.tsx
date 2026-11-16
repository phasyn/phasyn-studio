// The Project panel: the project's media (the takes of its shots and uploaded video, sound and images). The toolbar
// searches, filters by kind, sorts, switches between a list and thumbnails and imports files; dropping files on the
// panel imports them too. A click selects an item; a double click or Enter loads it into the Source monitor; every
// item can be dragged towards the timeline and has a menu (its "⋯" button, a right click, Shift+F10).
import { FolderOpen, Search, SlidersHorizontal, Type } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { CARD } from "@/components/ui/look";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { isMenuKey } from "@/lib/keyboard";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { ReferenceUploadRow } from "../../references/UploadRow";
import { useReferenceUploads } from "../../references/useReferenceUploads";
import { useEditor } from "../editorContext";
import { chordOf } from "../keymap";
import {
  MEDIA_VIEWS,
  mediaItems,
  SORT_DIRECTIONS,
  SORT_KEYS,
  visibleMedia,
  type KindFilter,
  type MediaItem,
  type MediaView,
  type SortDirection,
  type SortKey,
} from "./project/media";
import { MediaCell, MediaRow, type MediaEntryProps } from "./project/MediaEntries";
import { mediaMenu } from "./project/mediaMenu";
import { ProjectToolbar } from "./project/ProjectToolbar";

const NO_REFERENCES: never[] = [];
const LIST = "py-1";
/** Two thumbnails side by side in the narrowest panel (260 px), three at 420 px. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] content-start gap-2 p-2";

interface OpenMenu {
  itemId: string;
  anchor: MenuAnchor;
  returnFocus: HTMLElement;
}

/** Columns of the thumbnail grid as it is laid out now: the entries that share the first one's top edge. */
function gridColumns(grid: HTMLElement): number {
  const entries = [...grid.querySelectorAll<HTMLElement>("[data-media-item]")];
  const top = entries[0]?.offsetTop;
  return Math.max(1, entries.filter((entry) => entry.offsetTop === top).length);
}

/** Brings an entry into the visible part of the panel's own scroll area; nothing outside it moves. */
function scrollIntoBody(body: HTMLElement, entry: HTMLElement): void {
  const frame = body.getBoundingClientRect();
  const box = entry.getBoundingClientRect();
  if (box.top < frame.top) body.scrollTop -= frame.top - box.top;
  else if (box.bottom > frame.bottom) body.scrollTop += box.bottom - frame.bottom;
}

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes("Files");
}

export function ProjectPanel() {
  const editor = useEditor();
  const { project, timeline, fps, ui, dispatch, notify } = editor;
  const gridId = useId();
  const menuId = useId();
  // The file picker is found by its id, not through a ref: the toolbar's Import handler is built during render
  const pickerId = useId();
  const body = useRef<HTMLDivElement>(null);
  const loadedId = editor.source?.source_id ?? null;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = usePersistentChoice<SortKey>("studio.nle.project.sort", "kind", SORT_KEYS);
  const [direction, setDirection] = usePersistentChoice<SortDirection>("studio.nle.project.direction", "ascending", SORT_DIRECTIONS);
  const [view, setView] = usePersistentChoice<MediaView>("studio.nle.project.view", "list", MEDIA_VIEWS);
  const [selectedId, setSelectedId] = useState<string | null>(loadedId);
  const [revealed, setRevealed] = useState<number | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [dropping, setDropping] = useState(false);
  // The project's own upload flow: the file goes to the Controller and joins the project's library, which makes it a source
  const uploads = useReferenceUploads({
    projectId: project.project_id,
    shotId: null,
    library: project.library ?? [],
    references: NO_REFERENCES,
    onLibraryChange: (library) => dispatch({ type: "setLibrary", library }),
    onReferencesChange: () => undefined,
  });
  // The queue belongs to this panel and stops with it: leaving the panel (another tab of its group) while files are
  // still on their way ends them, and that is said instead of passing unnoticed
  const uploading = uploads.tasks.some((task) => task.state === "waiting" || task.state === "reading" || task.state === "uploading");
  const unfinished = useRef(false);
  useEffect(() => {
    unfinished.current = uploading;
  }, [uploading]);
  useEffect(
    () => () => {
      if (unfinished.current) notify({ tone: "warning", title: t("匯入已中止"), detail: t("離開「專案」面板時還沒上傳完的檔案沒有加入專案；請回到面板重新匯入。") });
    },
    [notify],
  );

  // "Reveal in project" (a command of the timeline) selects the loaded source and clears what could hide it
  const revealId = ui.intent?.panel === "project" ? ui.intent.id : null;
  if (revealId !== null && revealId !== revealed) {
    setRevealed(revealId);
    setSelectedId(loadedId);
    setQuery("");
    setKind("all");
  }

  const items = useMemo(() => mediaItems(editor.sources, timeline, editor.shorterTakes), [editor.sources, timeline, editor.shorterTakes]);
  // The New menu: what the timeline makes itself at the playhead (Premiere's New Item)
  const newItems: MenuItem[] = [
    { id: "adjustment", label: t("新增調整圖層"), icon: SlidersHorizontal, onSelect: editor.addAdjustmentLayer },
    { id: "text", label: t("新增文字圖層"), icon: Type, shortcut: chordOf("addText"), onSelect: editor.addTextLayer },
  ];
  const shown = useMemo(() => visibleMedia(items, query, kind, sortKey, direction), [items, query, kind, sortKey, direction]);
  const selected = shown.find((item) => item.id === selectedId) ?? null;
  const menuItem = menu ? (items.find((item) => item.id === menu.itemId) ?? null) : null;

  // The selected item is brought into view when the panel opens, when a command reveals it and when the view changes.
  // Not on a click: the list must not move under the pointer between the two presses of a double click (the arrow keys
  // move the focus, which scrolls by itself)
  const showSelected = useEffectEvent(() => {
    const scroller = body.current;
    const entry = selectedId === null ? null : scroller?.querySelector<HTMLElement>(`[data-media-item="${CSS.escape(selectedId)}"]`);
    if (scroller && entry) scrollIntoBody(scroller, entry);
  });
  useEffect(() => {
    showSelected();
  }, [view, revealed]);

  const entryOf = (id: string) => document.getElementById(gridId)?.querySelector<HTMLElement>(`[data-media-item="${CSS.escape(id)}"]`) ?? null;
  const open = (item: MediaItem) => {
    editor.setSourceId(item.id);
    ui.request({ panel: "source" });
  };
  // Asked first (ShorterTakeDialog): the take trims clips and clears the edit history
  const applyShorter = (item: MediaItem) => {
    if (item.shorter) editor.requestShorter(item.shorter);
  };
  const applying = editor.shorterAsked?.sourceId ?? null;
  const addFiles = (files: File[]) => {
    if (files.length > 0) uploads.addFiles(files, false);
  };
  const clearFilters = () => {
    setQuery("");
    setKind("all");
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const entry = event.target instanceof HTMLElement ? event.target : null;
    const at = shown.findIndex((item) => item.id === entry?.dataset.mediaItem);
    const current = shown[at];
    if (!entry || !current || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(current);
      return;
    }
    if (isMenuKey(event)) {
      event.preventDefault();
      setMenu({ itemId: current.id, anchor: { kind: "element", element: entry }, returnFocus: entry });
      return;
    }
    const columns = view === "grid" ? gridColumns(event.currentTarget) : 1;
    const moves: Record<string, number> = {
      ArrowUp: at - columns,
      ArrowDown: at + columns,
      Home: 0,
      End: shown.length - 1,
      ...(view === "grid" ? { ArrowLeft: at - 1, ArrowRight: at + 1 } : {}),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const target = shown[move];
    if (target) entryOf(target.id)?.focus();
  };

  const entryProps = (item: MediaItem, index: number): MediaEntryProps => ({
    item,
    index,
    fps,
    selected: item.id === selected?.id,
    tabbable: selected ? item.id === selected.id : index === 0,
    loaded: item.id === loadedId,
    menuId,
    menuOpen: menu?.itemId === item.id,
    applying: applying === item.id,
    onSelect: () => setSelectedId(item.id),
    onOpen: () => open(item),
    onMenu: (anchor, entry) => setMenu({ itemId: item.id, anchor, returnFocus: entry }),
    onMenuClose: () => setMenu(null),
    onApplyShorter: () => applyShorter(item),
  });

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <ProjectToolbar
        query={query}
        onQuery={setQuery}
        kind={kind}
        onKind={setKind}
        sortKey={sortKey}
        direction={direction}
        onSortKey={setSortKey}
        onDirection={setDirection}
        view={view}
        onView={setView}
        onImport={() => document.getElementById(pickerId)?.click()}
        newItems={newItems}
      />
      <input
        id={pickerId}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          addFiles(files);
        }}
      />
      <div ref={body} className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">
        {uploads.tasks.length > 0 ? (
          <ul aria-label={t("上傳")} aria-live="polite" className={cn(CARD, "mx-2 mt-2 grid shrink-0 gap-0.5 p-1")}>
            {uploads.tasks.map((task) => (
              <ReferenceUploadRow key={task.key} task={task} onRetry={() => uploads.retry(task.key)} onDismiss={() => uploads.dismiss(task.key)} />
            ))}
          </ul>
        ) : null}
        {items.length === 0 ? (
          <div className="grid flex-1 place-items-center">
            <EmptyState
              size="compact"
              icon={<FolderOpen />}
              title={t("還沒有素材")}
              description={t("渲染鏡頭，或把影片、聲音與圖片拖到這裡匯入。")}
            />
          </div>
        ) : shown.length === 0 ? (
          <div className="grid flex-1 place-items-center">
            <EmptyState
              size="compact"
              icon={<Search />}
              title={t("沒有符合的素材")}
              action={
                <Button size="sm" onClick={clearFilters}>
                  {t("清除篩選")}
                </Button>
              }
            />
          </div>
        ) : (
          <div id={gridId} role="grid" aria-label={t("專案素材清單")} data-delete-keys="" onKeyDown={keys} className={view === "grid" ? GRID : LIST}>
            {shown.map((item, index) =>
              view === "grid" ? <MediaCell key={item.id} {...entryProps(item, index)} /> : <MediaRow key={item.id} {...entryProps(item, index)} />,
            )}
          </div>
        )}
      </div>
      {dropping ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-lg border-2 border-dashed border-brand-cyan/80 bg-brand-soft"
        >
          <span className="rounded-full border border-line-strong bg-overlay px-3 py-1 text-caption text-fg shadow-popover">
            {t("放開以匯入到專案")}
          </span>
        </div>
      ) : null}
      {menu && menuItem ? (
        <ActionMenu
          id={menuId}
          label={t("「{name}」的動作", { name: menuItem.name })}
          items={mediaMenu(editor, menuItem, { open: () => open(menuItem), applyShorter: () => applyShorter(menuItem) })}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
