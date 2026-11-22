// The Captions panel: the sequence's captions in time order. The toolbar adds a caption at the playhead and imports
// or exports SRT; choosing a caption (a click, or the arrow keys) selects it and moves the playhead to it, and the
// detail area under the list edits the selected caption's text, range, position and size. The selection is the
// editor's one selection, shared with the caption track of the timeline: choosing a segment there selects its row
// here and brings it into view. A row's menu (right click, Shift+F10) and the keys Enter and Delete carry the rest;
// Delete anywhere in the panel removes the selected caption. Every change is one commit of the timeline document.
// Under the toolbar, the dialogue row (dialogue/DialogueBar) turns clips' speech into captions and captions into speech.
import { Captions, Download, MapPin, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { TimelineCaption } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { isInOverlay, isMenuKey, isTextEntry } from "@/lib/keyboard";
import type { PlayheadStore } from "../../hooks/playhead";
import { localId } from "../../model/ids";
import { errorText } from "../../swap/errors";
import { downloadSrt, parseSrt } from "../captions";
import { useEditor } from "../editorContext";
import { DialogueBar } from "../../dialogue/DialogueBar";
import { CaptionDetail } from "./captions/CaptionDetail";
import { captionLimit, captionLine, newCaption, sortedCaptions, withCaption } from "./captions/captionEdits";
import { CaptionRow } from "./captions/CaptionRow";

/** Largest SRT file the import reads (the same bound parseSrt puts on its text). */
const MAX_SRT_BYTES = 1_000_000;

interface OpenMenu {
  captionId: string;
  anchor: MenuAnchor;
  returnFocus: HTMLElement;
}

/** The caption the playhead is on. Read as its id, so a moving playhead renders only when the answer changes. */
function useCurrentCaption(playhead: PlayheadStore, captions: readonly TimelineCaption[]): string | null {
  return useSyncExternalStore(playhead.subscribe, () => {
    const frame = playhead.getFrame();
    return captions.find((caption) => caption.start_frame <= frame && frame < caption.end_frame)?.caption_id ?? null;
  });
}

/** Brings a row into the visible part of the list; nothing outside the list moves. */
function scrollIntoList(list: HTMLElement, row: HTMLElement): void {
  const frame = list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < frame.top) list.scrollTop -= frame.top - box.top;
  else if (box.bottom > frame.bottom) list.scrollTop += box.bottom - frame.bottom;
}

export function CaptionsPanel() {
  const editor = useEditor();
  const { timeline, fps, transport, playhead } = editor;
  // Rows and the file picker are found by id, not through refs: handlers built during render must not close over a ref
  const listId = useId();
  const pickerId = useId();
  const menuId = useId();
  const selectedId = editor.selectedCaption;
  const [freshId, setFreshId] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [importing, setImporting] = useState(false);
  // An import finishes after the file was read: it continues from the editor as it is then
  const liveRef = useRef(editor);
  const panelId = useId();
  useLayoutEffect(() => {
    liveRef.current = editor;
  });
  const captions = useMemo(() => sortedCaptions(timeline.captions), [timeline.captions]);
  const currentId = useCurrentCaption(playhead, captions);
  const selected = captions.find((caption) => caption.caption_id === selectedId) ?? null;
  const menuCaption = menu ? (captions.find((caption) => caption.caption_id === menu.captionId) ?? null) : null;
  const limit = captionLimit(timeline);

  const rowOf = (captionId: string) => document.getElementById(listId)?.querySelector<HTMLElement>(`[data-caption-row="${CSS.escape(captionId)}"]`) ?? null;
  // The selected caption stays in view: a new one may lie outside the list's window, and the detail area that opens
  // under the list takes room from it
  useEffect(() => {
    const list = document.getElementById(listId);
    const row = selectedId === null ? null : list?.querySelector<HTMLElement>(`[data-caption-row="${CSS.escape(selectedId)}"]`);
    if (list && row) scrollIntoList(list, row);
  }, [listId, selectedId]);

  /** Selecting a caption (here or on the timeline) moves the playhead to it. */
  const select = (caption: TimelineCaption) => {
    editor.selectCaption(caption.caption_id);
    transport.seek(caption.start_frame);
    if (caption.caption_id !== freshId) setFreshId(null);
  };
  const change = (captionId: string, patch: Partial<TimelineCaption>) => editor.commit(withCaption(timeline, captionId, patch));
  const add = () => {
    const caption = newCaption(localId("caption"), playhead.getFrame(), fps);
    if (!editor.commit({ ...timeline, captions: [...timeline.captions, caption] })) return;
    editor.selectCaption(caption.caption_id);
    setFreshId(caption.caption_id);
  };
  const remove = (caption: TimelineCaption) => {
    const at = captions.findIndex((item) => item.caption_id === caption.caption_id);
    const next = captions[at + 1] ?? captions[at - 1] ?? null;
    const focused = rowOf(caption.caption_id)?.contains(document.activeElement) ?? false;
    // The neighbour takes over what the removed caption held: the selection (removeCaption moves it), and the focus
    // (so Delete can go on)
    if (!editor.removeCaption(caption.caption_id) || !focused) return;
    if (next) rowOf(next.caption_id)?.focus();
    else document.getElementById(panelId)?.focus({ preventScroll: true });
  };
  const importSrt = (file: File) => {
    if (file.size > MAX_SRT_BYTES) {
      editor.warn(t("字幕檔不得超過 1 MB"));
      return;
    }
    setImporting(true);
    void file
      .text()
      .then((text) => {
        const now = liveRef.current;
        const added = parseSrt(text, now.fps);
        if (!now.commit({ ...now.timeline, captions: [...now.timeline.captions, ...added] })) return;
        now.notify({ tone: "success", title: t("已匯入 {count} 段字幕", { count: added.length }) });
      })
      .catch((error: unknown) => { liveRef.current.warn(errorText(error)); })
      .finally(() => { setImporting(false); });
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = event.target instanceof HTMLElement ? event.target : null;
    const at = captions.findIndex((caption) => caption.caption_id === row?.dataset["captionRow"]);
    const caption = captions[at];
    if (!row || !caption || event.altKey || event.ctrlKey || event.metaKey) return;
    const moves: Record<string, number> = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: captions.length - 1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      const target = captions[move];
      if (!target) return;
      select(target);
      rowOf(target.caption_id)?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      transport.seek(caption.start_frame);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      // The one selection: a caption chosen on the timeline since this row took the focus goes, not this row's. A held
      // key removes one caption, not one per repeat
      if (!event.repeat) remove(selected ?? caption);
    } else if (isMenuKey(event)) {
      event.preventDefault();
      setMenu({ captionId: caption.caption_id, anchor: { kind: "element", element: row }, returnFocus: row });
    }
  };
  const rowItems = (caption: TimelineCaption): MenuItem[] => [
    { id: "seek", label: t("把播放頭移到這段字幕"), icon: MapPin, shortcut: "Enter", onSelect: () => { transport.seek(caption.start_frame); } },
    { id: "in", label: t("把入點設為播放頭"), separatorBefore: true, onSelect: () => void change(caption.caption_id, { start_frame: playhead.getFrame() }) },
    // Like Mark Out: the caption still shows on the playhead's frame
    { id: "out", label: t("把出點設為播放頭"), onSelect: () => void change(caption.caption_id, { end_frame: playhead.getFrame() + 1 }) },
    { id: "remove", label: t("刪除字幕"), icon: Trash2, shortcut: "Delete", tone: "danger", separatorBefore: true, onSelect: () => { remove(caption); } },
  ];

  // Delete elsewhere in the panel (its toolbar, the panel itself) removes the selected caption: the rows take theirs first
  const panelKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented || isTextEntry(event.target) || isInOverlay(event.target)) return;
    event.preventDefault();
    const caption = captions.find((item) => item.caption_id === selectedId);
    if (caption && !event.repeat) remove(caption);
  };

  return (
    // The panel takes the focus when the row that had it removes itself and no row is left: Delete stays here instead of reaching the selected clip
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  id={panelId} tabIndex={-1} data-delete-keys="" onKeyDown={panelKeys} className="flex min-h-0 flex-1 flex-col outline-none">
      <div data-keep-focus="" className="@container flex h-10 shrink-0 items-center gap-1.5 border-b border-line-subtle px-2">
        <ActionButton size="sm" icon={<Plus aria-hidden />} disabledReason={limit} title={t("在播放頭新增字幕；字幕會燒錄到匯出的影片")} onClick={add}>
          {t("新增字幕")}
        </ActionButton>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            icon={<Upload aria-hidden />}
            pending={importing}
            aria-label={t("匯入 SRT")}
            title={t("匯入 SRT 字幕檔：加在現有字幕之後")}
            onClick={() => document.getElementById(pickerId)?.click()}
          >
            <span className="hidden @[24rem]:inline">{t("匯入 SRT")}</span>
          </Button>
          <ActionButton
            size="sm"
            icon={<Download aria-hidden />}
            disabledReason={captions.length === 0 ? t("還沒有字幕可以匯出") : null}
            aria-label={t("匯出 SRT")}
            title={t("把字幕另存成 SRT 字幕檔")}
            onClick={() => { downloadSrt(timeline.captions, fps); }}
          >
            <span className="hidden @[24rem]:inline">{t("匯出 SRT")}</span>
          </ActionButton>
        </span>
        <input
          id={pickerId}
          type="file"
          accept=".srt,application/x-subrip,text/plain"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && !importing) importSrt(file);
          }}
        />
      </div>
      <DialogueBar />
      {captions.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
          <EmptyState size="compact" icon={<Captions />} title={t("還沒有字幕")} description={t("從片段辨識台詞、在播放頭新增字幕，或匯入 SRT 字幕檔。")} />
        </div>
      ) : (
        <div tabIndex={-1} id={listId} role="grid" aria-label={t("序列字幕")} data-delete-keys="" onKeyDown={keys} className="min-h-13 flex-1 overflow-y-auto py-1">
          {captions.map((caption, index) => (
            <CaptionRow
              key={caption.caption_id}
              caption={caption}
              index={index}
              fps={fps}
              selected={caption.caption_id === selected?.caption_id}
              tabbable={selected ? caption.caption_id === selected.caption_id : index === 0}
              current={caption.caption_id === currentId}
              onSelect={() => { select(caption); }}
              onRemove={() => { remove(caption); }}
              onMenu={(anchor, row) => { setMenu({ captionId: caption.caption_id, anchor, returnFocus: row }); }}
            />
          ))}
        </div>
      )}
      {selected ? (
        <CaptionDetail key={selected.caption_id} caption={selected} fresh={selected.caption_id === freshId} onChange={(patch) => change(selected.caption_id, patch)} />
      ) : null}
      {menu && menuCaption ? (
        <ActionMenu
          id={menuId}
          label={t("「{name}」的動作", { name: captionLine(menuCaption.text) })}
          items={rowItems(menuCaption)}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
    </div>
  );
}
