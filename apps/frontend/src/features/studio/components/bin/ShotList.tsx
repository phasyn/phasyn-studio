// The 鏡頭 tab of the project panel: the toolbar (新增鏡頭; 批次渲染 with what would really be sent; the blocked shots; the
// DiT lanes), the bar of a multi-selection (its 渲染變體 and 換參考檔案 dialogs, and the notice with 復原 after 換參考檔案),
// and the shots in film order
// (the clips of the first video track; shots without a clip follow under 未上時間軸) as one multi-select listbox. The
// list's current shot is the Studio's selected shot; clicks, Shift, Ctrl/⌘ and the keys choose as in the asset library
// (model/shotSelection.ts), and a multi-selection is published for the engine sheet's 路線 tab (shotListSelection.ts).
// The list carries data-arrow-keys and data-keep-focus: the editor's key map leaves its keys alone, and pressing a row's
// eye or "…" keeps the focus on the list. Rows enter one after another and slide to their new place when the order
// changes.
import { Film } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { useFlipList } from "@/components/ui/motion";
import { isMenuKey } from "@/lib/keyboard";
import { t } from "@/i18n";
import { useEditor } from "../../editor/editorContext";
import { filmOrder } from "../../editor/sources";
import { useShotActions } from "../../hooks/useShotActions";
import type { ShotMenuState } from "../../model/shotActions";
import { focusShot, isBatchSelection, keepCurrent, moveTo, selectAll, selectCurrent, selectOnly, selectRange, toggleSelected, type ShotSelection } from "../../model/shotSelection";
import { useRenderActivity } from "../../renderActivityContext";
import { DeleteShotDialog, ShotActionMenu } from "../ShotActions";
import { BatchDeleteDialog } from "./BatchDeleteDialog";
import { BatchReplaceDialog } from "./BatchReplaceDialog";
import { BatchToolbar } from "./BatchToolbar";
import { BatchVariantsDialog } from "./BatchVariantsDialog";
import { batchCandidates, splitBlocked } from "./batchScope";
import { createBlockReports, useBlockReasons } from "./blockReports";
import { ReplaceNotice, type AppliedReplace } from "./ReplaceNotice";
import { activityByShot } from "./rowFacts";
import { SelectionBar } from "./SelectionBar";
import { usePublishShotSelection } from "./shotListSelection";
import { SHOT_ROW_HEIGHT, ShotRow } from "./ShotRow";
import { useShotSelection } from "./useShotSelection";

/** The shot that becomes current when `removed` leave the list: the first one after them, else the nearest before. */
function nextAfter(order: readonly string[], removed: ReadonlySet<string>): string | null {
  const last = Math.max(...order.map((id, index) => (removed.has(id) ? index : -1)));
  return order.slice(last + 1).find((id) => !removed.has(id)) ?? [...order.slice(0, Math.max(0, last))].reverse().find((id) => !removed.has(id)) ?? null;
}

export function ShotList() {
  const { project, timeline } = useEditor();
  const actions = useShotActions();
  const activity = useRenderActivity();
  const baseId = useId();
  const menuId = useId();
  const hintId = useId();
  const unplacedLabel = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<HTMLDivElement>(null);
  const unplacedRef = useRef<HTMLDivElement>(null);
  const [reports] = useState(createBlockReports);
  const reasons = useBlockReasons(reports);
  const [menu, setMenu] = useState<ShotMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [batchDelete, setBatchDelete] = useState<readonly string[] | null>(null);
  // 換參考檔案: mounted once per opening (session) and kept while it closes, so its exit animates
  const [batchReplace, setBatchReplace] = useState<{ shotIds: readonly string[]; open: boolean; session: number } | null>(null);
  // 渲染變體: the same, so its exit animates too
  const [batchVariants, setBatchVariants] = useState<{ shotIds: readonly string[]; open: boolean; session: number } | null>(null);
  // What the last 換參考檔案 changed (with 復原); a new one replaces it. Its id is the session it was applied in (one
  // 套用 per opening), so a new notice never takes over one that is still fading out
  const [replaced, setReplaced] = useState<AppliedReplace | null>(null);
  const dismissReplaced = useCallback(() => setReplaced(null), []);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ shotId: string; after: boolean } | null>(null);

  // One order: the film order is the order of the clips on the first video track; shots without a clip follow. The
  // derived lists keep their identity while nothing they come from changes (the batch's estimate is keyed on them)
  const { placed, unplaced } = useMemo(() => filmOrder(project, timeline), [project, timeline]);
  const shots = useMemo(() => [...placed, ...unplaced], [placed, unplaced]);
  const order = useMemo(() => shots.map((shot) => shot.shot_id), [shots]);
  const { selection, apply } = useShotSelection(order);
  const focus = selection.focus;
  const batch = isBatchSelection(selection);
  const selected = useMemo(() => (batch ? shots.filter((shot) => selection.ids.has(shot.shot_id)) : null), [batch, shots, selection]);
  const selectedIds = useMemo(() => selected?.map((shot) => shot.shot_id) ?? null, [selected]);
  usePublishShotSelection(selectedIds);
  const scope = useMemo(() => batchCandidates(project, placed, selected), [project, placed, selected]);
  const candidates = useMemo(() => new Set(scope.candidates.map((shot) => shot.shot_id)), [scope]);
  const { renderable, blocked } = useMemo(() => splitBlocked(scope.candidates, reasons), [scope, reasons]);
  const positions = useMemo(() => new Map(placed.map((shot, index) => [shot.shot_id, index])), [placed]);
  const rendering = useMemo(() => activityByShot(activity), [activity]);
  const openMenu = menu && order.includes(menu.shotId) ? menu : null;

  useFlipList(placedRef, placed.map((shot) => shot.shot_id).join("\n"));
  useFlipList(unplacedRef, unplaced.map((shot) => shot.shot_id).join("\n"));
  // The current shot stays in view (chosen with the keyboard, in the timeline or by a link): only the list scrolls
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const element = focus === null ? null : listRef.current?.querySelector(`[data-shot-option="${CSS.escape(focus)}"]`);
    if (!scroller || !element) return;
    const box = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
  }, [focus]);

  const focusList = () => requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  const rowElement = (shotId: string) => listRef.current?.querySelector<HTMLElement>(`[data-shot-option="${CSS.escape(shotId)}"]`) ?? null;
  const showMenu = (shotId: string, anchor: MenuAnchor) => {
    apply(focusShot(selection, shotId));
    setMenu({ shotId, anchor, returnFocus: listRef.current, focus: "first" });
  };
  const requestDelete = () => {
    if (selectedIds) setBatchDelete(selectedIds);
    else if (focus !== null) setPendingDelete(focus);
  };
  const replaceReferences = () => {
    if (!selectedIds) return;
    setBatchReplace((current) => ({ shotIds: selectedIds, open: true, session: (current?.session ?? 0) + 1 }));
  };
  const renderVariants = () => {
    if (!selectedIds) return;
    setBatchVariants((current) => ({ shotIds: selectedIds, open: true, session: (current?.session ?? 0) + 1 }));
  };
  const removed = (shotIds: readonly string[]) => {
    const next = nextAfter(order, new Set(shotIds));
    apply(selectCurrent(next), { open: true });
  };
  const duplicateSelected = () => {
    if (!selectedIds) return;
    // The copies become the selection, the first one current
    const ids = actions.duplicateAll(selectedIds);
    const first = ids[0];
    if (first !== undefined) apply({ ids: new Set(ids), focus: first, anchor: first }, { open: true });
  };

  const onPointer = (event: MouseEvent<HTMLElement>, shotId: string) => {
    const mod = event.ctrlKey || event.metaKey;
    const next: ShotSelection = event.shiftKey ? selectRange(selection, order, shotId, mod) : mod ? toggleSelected(selection, shotId) : selectOnly(shotId);
    apply(next, { open: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (order.length === 0) return;
    const at = focus === null ? -1 : order.indexOf(focus);
    const mod = event.ctrlKey || event.metaKey;
    const move = (index: number) => {
      event.preventDefault();
      apply(moveTo(selection, order, index, event.shiftKey ? "extend" : mod ? "keep" : "select"));
    };
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? SHOT_ROW_HEIGHT) / SHOT_ROW_HEIGHT));
    if (isMenuKey(event)) {
      event.preventDefault();
      const row = focus === null ? null : rowElement(focus);
      if (focus !== null && row) showMenu(focus, { kind: "element", element: row });
      return;
    }
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown": {
        const delta = event.key === "ArrowUp" ? -1 : 1;
        if (event.altKey) {
          // Alt+↑／↓: the current shot one place earlier or later in the film
          event.preventDefault();
          if (focus !== null && !event.repeat) actions.move(focus, delta);
          return;
        }
        move(at < 0 ? 0 : at + delta);
        return;
      }
      case "Home":
        move(0);
        return;
      case "End":
        move(order.length - 1);
        return;
      case "PageUp":
        move(at < 0 ? 0 : at - page);
        return;
      case "PageDown":
        move(at < 0 ? 0 : at + page);
        return;
      case " ":
        event.preventDefault();
        if (focus !== null && !event.repeat) apply(event.shiftKey ? selectRange(selection, order, focus, true) : toggleSelected(selection, focus));
        return;
      case "Enter":
        if (focus === null) return;
        event.preventDefault();
        actions.openInSource(focus);
        return;
      case "Escape":
        // Only when there is something to clear; otherwise Escape keeps its meaning elsewhere
        if (focus === null || (selection.ids.size === 1 && selection.ids.has(focus))) return;
        event.preventDefault();
        apply(keepCurrent(selection));
        return;
      case "Delete":
      case "Backspace":
        if (event.altKey || mod) return;
        event.preventDefault();
        if (!event.repeat) requestDelete();
        return;
      default:
        if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
          event.preventDefault();
          apply(selectAll(order, focus));
        }
    }
  };

  const row = (shot: StudioShot, index: number, position: number | null) => (
    <ShotRow
      key={shot.shot_id}
      shot={shot}
      optionId={`${baseId}-${shot.shot_id}`}
      position={position}
      index={index}
      selected={selection.ids.has(shot.shot_id)}
      current={shot.shot_id === focus}
      batch={batch}
      candidate={candidates.has(shot.shot_id)}
      reports={reports}
      activity={rendering.get(shot.shot_id)}
      menuOpen={openMenu?.shotId === shot.shot_id}
      dropEdge={dragging && dragging !== shot.shot_id && dropAt?.shotId === shot.shot_id ? (dropAt.after ? "after" : "before") : null}
      onPointer={onPointer}
      onMenu={showMenu}
      onCloseMenu={() => setMenu(null)}
      onToggleTimeline={(shotId, on) => void actions.setInTimeline(shotId, on)}
      onDragShot={(shotId) => {
        setDragging(shotId);
        if (!shotId) setDropAt(null);
      }}
      onDragOverShot={(shotId, after) => setDropAt((current) => (current?.shotId === shotId && current.after === after ? current : { shotId, after }))}
      onDropShot={(targetId, after) => {
        const moving = dragging;
        setDropAt(null);
        setDragging(null);
        if (moving) actions.moveTo(moving, targetId, after ? "after" : "before");
      }}
    />
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <BatchToolbar scope={scope} renderable={renderable} blocked={blocked} positions={positions} onShowBlocked={(shotId) => apply(focusShot(selection, shotId), { open: true })} />
      <AnimatePresence initial={false}>
        {selected ? (
          <SelectionBar key="selection" shots={selected} onRenderVariants={renderVariants} onReplaceReferences={replaceReferences} onDuplicate={duplicateSelected} onDelete={requestDelete} onClear={() => apply(keepCurrent(selection))} />
        ) : null}
      </AnimatePresence>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-1 [scrollbar-gutter:stable]">
        {shots.length === 0 ? (
          <EmptyState size="compact" icon={<Film />} title={t("還沒有鏡頭")} description={t("每個鏡頭是一段 prompt；新增後就排在時間軸上，渲染完成即可播放與匯出。")} />
        ) : (
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-multiselectable
            aria-label={t("鏡頭清單")}
            aria-describedby={hintId}
            aria-activedescendant={focus !== null ? `${baseId}-${focus}` : undefined}
            aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown Space Control+A Meta+A Escape Delete Alt+ArrowUp Alt+ArrowDown Shift+F10"
            data-arrow-keys=""
            data-keep-focus=""
            onKeyDown={onKeyDown}
            onFocus={(event) => {
              // Tabbing in without a current shot: the first one becomes current (without scrolling away)
              if (event.target === event.currentTarget && focus === null && order[0] !== undefined) apply(selectOnly(order[0]));
            }}
            className="group/shots grid outline-none"
          >
            <div ref={placedRef} role="presentation" className="grid">
              {placed.map((shot, index) => row(shot, index, index))}
            </div>
            {unplaced.length > 0 ? (
              <div role="group" aria-labelledby={unplacedLabel} className="grid">
                <div id={unplacedLabel} aria-hidden className="mt-1 flex items-center gap-2 px-3 pt-2 pb-1 text-caption text-fg-tertiary">
                  <span className="shrink-0">{t("未上時間軸")}</span>
                  <span className="h-px flex-1 bg-line-subtle" />
                </div>
                <div ref={unplacedRef} role="presentation" className="grid">
                  {unplaced.map((shot, index) => row(shot, placed.length + index, null))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <span id={hintId} className="sr-only">
        {[t("↑↓ 移動、Shift 延伸、空白鍵加選或取消、Ctrl／⌘＋A 全選、Esc 只留目前的鏡頭"), t("Alt+↑／↓ 調整順序、Delete 刪除、右鍵或 Shift+F10 開啟動作選單")].join(t("；"))}
      </span>
      <ShotActionMenu menuId={menuId} menu={openMenu} onClose={() => setMenu(null)} onRequestDelete={setPendingDelete} />
      <DeleteShotDialog shotId={pendingDelete} onClose={() => setPendingDelete(null)} onFocusList={focusList} />
      <BatchDeleteDialog shotIds={batchDelete} onClose={() => setBatchDelete(null)} onRemoved={removed} onFocusList={focusList} />
      {batchReplace ? (
        <BatchReplaceDialog
          key={batchReplace.session}
          shotIds={batchReplace.shotIds}
          open={batchReplace.open}
          onClose={() => setBatchReplace((current) => (current ? { ...current, open: false } : current))}
          onApplied={(applied) => setReplaced({ ...applied, id: batchReplace.session })}
        />
      ) : null}
      {batchVariants ? (
        <BatchVariantsDialog
          key={batchVariants.session}
          shotIds={batchVariants.shotIds}
          open={batchVariants.open}
          positions={positions}
          onClose={() => setBatchVariants((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
      <AnimatePresence>{replaced ? <ReplaceNotice key={replaced.id} notice={replaced} onDismiss={dismissReplaced} returnFocus={focusList} /> : null}</AnimatePresence>
    </div>
  );
}
