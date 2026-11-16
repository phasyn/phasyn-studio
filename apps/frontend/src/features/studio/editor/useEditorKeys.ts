// Runs the key map (keymap.ts) for the whole Video Studio from one window listener. Shortcuts act on the focused
// panel: transport keys drive the Source monitor while it has the focus (in Shots: the take preview while it shows),
// otherwise the sequence. Text fields, dialogs and menus keep their keys, and a focused control keeps the keys it
// uses itself (a button its Space, a slider its arrows). Chrome marked data-keep-focus does not take the focus on a
// click, so Space keeps playing after pressing a toolbar button.
import { useEffect, useEffectEvent } from "react";
import { t } from "@/i18n";
import { isInOverlay, isTextEntry } from "@/lib/keyboard";
import type { Editor } from "./editorContext";
import { extendToPlayhead, clipUnderPlayhead, trimToPlayhead } from "./keyEdits";
import { keyBinding, type EditorCommandId } from "./keymap";
import { timelineDuration } from "./model";
import { sourceRange } from "./sourceMarks";
import { adjacentEditPoint } from "./timelineGeometry";
import { requestTimelineZoom } from "./timelineView";
import { applyAtSpots, defaultTransitionSpots, defaultTransitionsLabel, type DefaultTransitions } from "./transitionPlacement";

/** Controls that Space presses (a link, a slider and a splitter do not use it, so there it still plays). */
const SPACE = "button, summary, select, input:not([type=range]), [role=button]:not([data-editor-clip]), [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=option]";
const ARROWS = "input, select, [role=slider], [role=tab], [role=radio], [role=separator], [role=listbox], [role=option], [role=tree], [role=treeitem], [role=grid], [data-studio-row], [data-arrow-keys]";
const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * Commands that change the document: a key that is held down (or a second Delete that the keyboard sends while the
 * focus is on its way from a row that just removed itself) does not run them again.
 */
const ONCE_PER_PRESS: ReadonlySet<EditorCommandId> = new Set<EditorCommandId>([
  "delete",
  "rippleDelete",
  "lift",
  "extract",
  "cut",
  "paste",
  "pasteInsert",
  "pasteAttributes",
  "insert",
  "overwrite",
  "addEdit",
  "addEditAll",
  "rippleTrimPrevious",
  "rippleTrimNext",
  "trimPrevious",
  "trimNext",
  "extendEdit",
  "toggleEnabled",
  "defaultVideoTransition",
  "defaultAudioTransition",
  "defaultTransitions",
  "addMarker",
  "addText",
]);

/**
 * Ctrl/⌘+D, Ctrl/⌘+Shift+D, Shift+D: the default transitions at both ends of the selected clips, else at the edit spot
 * nearest the playhead on the targeted tracks; one step of the history. A spot that cannot take one is passed over;
 * when none could, the first reason is reported.
 */
function applyDefaultTransitions(editor: Editor, which: DefaultTransitions): void {
  if (editor.problem) {
    editor.warn(editor.problem);
    return;
  }
  const { timeline, selected, linked, targets } = editor;
  const entries = defaultTransitionSpots(timeline, which, { selected, linked, targets, frame: editor.playhead.getFrame() });
  if (entries.length === 0) {
    const offTrack = which === "audio" ? t("選取的片段都不在音訊軌上") : t("選取的片段都不在視訊軌上");
    editor.warn(selected.length > 0 ? offTrack : t("目標軌道上沒有可以加上轉場的片段；請在軌道標頭開啟目標"));
    return;
  }
  const result = applyAtSpots(timeline, entries, linked);
  const first = result.refusals[0];
  if (result.applied === 0) {
    if (first) editor.warn(first.reason);
    return;
  }
  editor.commit(result.timeline, defaultTransitionsLabel(which));
}

/** Whether the focused element uses this key itself (an SVG handle counts like any other element). */
function keepsKey(event: KeyboardEvent): boolean {
  const { target, key } = event;
  if (!(target instanceof Element)) return false;
  if (key === " ") return target.closest(SPACE) !== null;
  if (key === "Enter") return target.closest(`${SPACE}, a[href]`) !== null;
  if (ARROW_KEYS.has(key)) {
    // A monitor's scrub bar takes only the unmodified keys: Shift+→ and the other chords stay the key map's
    const chord = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
    return target.closest(ARROWS) !== null && !(chord && target.closest("[data-scrub-bar]"));
  }
  if (key === "Delete" || key === "Backspace") return target.closest("[data-studio-row], [data-delete-keys]") !== null;
  if (key === "Escape") return target.closest("[data-escape-key]") !== null;
  return false;
}

export function useEditorKeys(editor: Editor): void {
  const run = (id: EditorCommandId): void => {
    const { transport, playhead, timeline, workspace } = editor;
    const frame = playhead.getFrame();
    const monitor = editor.sourceMonitor.current();
    // The single-source monitor has the keys while it is the focused panel (Edit) or what the monitor shows (Shots)
    const source = monitor && (workspace === "edit" ? editor.focus.panel === "source" : editor.monitorMode === "source") ? monitor : null;
    const shuttle = (direction: -1 | 0 | 1, slow: boolean) => {
      if (source?.shuttle) source.shuttle(direction, slow);
      else if (direction === 0) transport.stop();
      else transport.shuttle(direction, slow);
    };
    const step = (frames: number) => (source ? source.step(frames) : transport.step(frames));
    const editPoint = (direction: -1 | 1) => {
      const tracks = editor.targets.size > 0 ? editor.targets : new Set(timeline.tracks.map((track) => track.track_id));
      transport.seek(adjacentEditPoint(timeline, tracks, frame, direction) ?? (direction < 0 ? 0 : timelineDuration(timeline)));
    };
    const trim = (edge: "in" | "out", ripple: boolean) => {
      const clip = clipUnderPlayhead(timeline, frame, editor.selectedClip, editor.targets);
      const command = trimToPlayhead(clip, frame, edge, ripple, editor.linked);
      if (!command.ok) editor.warn(command.error);
      else if (editor.command(command.value) && edge === "in" && ripple && clip) transport.seek(clip.start_frame);
    };
    const extend = () => {
      const command = extendToPlayhead(timeline, editor.selectedClip, frame, editor.linked);
      if (command.ok) editor.command(command.value);
      else editor.warn(command.error);
    };
    const place = (mode: "insert" | "overwrite") => {
      if (!editor.source) {
        editor.warn(t("來源監看器沒有素材；請先在「專案」面板選一個素材"));
        return;
      }
      const range = sourceRange(editor.project.project_id, editor.source, timeline.fps);
      editor.place(editor.source, range.inFrame, range.outFrame, mode);
    };
    const goMark = (edge: "in" | "out") => {
      if (source) source.seekEdge(edge);
      else if (timeline.work_area) transport.seek(edge === "in" ? timeline.work_area.start_frame : timeline.work_area.end_frame - 1);
    };
    const toggleLink = () => {
      const clips = timeline.clips.filter((clip) => editor.selected.includes(clip.clip_id));
      if (clips.length === 0) return;
      editor.command({ type: clips.some((clip) => clip.linked_id) ? "unlink" : "link", clipIds: editor.selected });
    };
    const save = () => {
      if (editor.drafts.commitAll()) void editor.flush().catch(() => editor.warn(t("專案尚未儲存，請查看儲存狀態")));
    };
    const actions: Record<EditorCommandId, () => void> = {
      playToggle: () => (source ? source.toggle() : transport.toggle()),
      shuttleBack: () => shuttle(-1, false),
      shuttleStop: () => shuttle(0, false),
      shuttleForward: () => shuttle(1, false),
      shuttleBackSlow: () => shuttle(-1, true),
      shuttleForwardSlow: () => shuttle(1, true),
      stepBack: () => step(-1),
      stepForward: () => step(1),
      stepBackFive: () => step(-5),
      stepForwardFive: () => step(5),
      previousEdit: () => editPoint(-1),
      nextEdit: () => editPoint(1),
      goStart: () => (source ? source.seekEdge("start") : transport.seek(0)),
      goEnd: () => (source ? source.seekEdge("end") : transport.seek(timelineDuration(timeline))),
      markIn: () => (source?.mark ? source.mark("in") : editor.markRange("in")),
      markOut: () => (source?.mark ? source.mark("out") : editor.markRange("out")),
      goIn: () => goMark("in"),
      goOut: () => goMark("out"),
      insert: () => place("insert"),
      overwrite: () => place("overwrite"),
      rippleTrimPrevious: () => trim("in", true),
      rippleTrimNext: () => trim("out", true),
      trimPrevious: () => trim("in", false),
      trimNext: () => trim("out", false),
      extendEdit: extend,
      addEdit: () => void editor.split(),
      addEditAll: () => void editor.split(true),
      lift: () => editor.removeRange(false),
      extract: () => editor.removeRange(true),
      toggleEnabled: () => void editor.toggleEnabled(),
      defaultVideoTransition: () => applyDefaultTransitions(editor, "video"),
      defaultAudioTransition: () => applyDefaultTransitions(editor, "audio"),
      defaultTransitions: () => applyDefaultTransitions(editor, "both"),
      delete: () => void editor.remove(false),
      rippleDelete: () => void editor.remove(true),
      addMarker: () => void editor.addMarker(),
      addText: editor.addTextLayer,
      toggleSnap: () => editor.setSnapping(!editor.snapping),
      toolSelect: () => editor.setTool("select"),
      toolRipple: () => editor.setTool("ripple"),
      toolRoll: () => editor.setTool("roll"),
      toolRazor: () => editor.setTool("razor"),
      toolSlip: () => editor.setTool("slip"),
      toolSlide: () => editor.setTool("slide"),
      zoomFit: () => requestTimelineZoom("fit"),
      zoomIn: () => requestTimelineZoom("in"),
      zoomOut: () => requestTimelineZoom("out"),
      undo: editor.undo,
      redo: editor.redo,
      copy: () => void editor.copy(),
      cut: editor.cut,
      paste: () => editor.paste("overwrite"),
      pasteInsert: () => editor.paste("insert"),
      pasteAttributes: () => {
        if (editor.attributesBlocked) editor.warn(editor.attributesBlocked);
        else editor.ui.setPastingAttributes(true);
      },
      selectAll: () => editor.setSelected(timeline.clips.map((clip) => clip.clip_id)),
      deselect: () => {
        transport.stop();
        editor.setSelected([]);
        editor.selectTransition(null);
      },
      toggleLink,
      save,
    };
    actions[id]();
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || editor.workspace === "render") return;
    const binding = keyBinding(event, editor.workspace === "edit" ? "edit" : "all");
    if (!binding || isInOverlay(event.target)) return;
    if (isTextEntry(event.target) ? !binding.inText : keepsKey(event)) return;
    // Copy with text selected on the page stays the browser's copy
    if (binding.id === "copy" && (window.getSelection()?.toString() ?? "") !== "") return;
    event.preventDefault();
    if (event.repeat && ONCE_PER_PRESS.has(binding.id)) return;
    run(binding.id);
  });
  const onPress = useEffectEvent((event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest("button, [role=button], [role=radio], [role=tab]");
    if (event.button !== 0 || !control || !control.closest("[data-keep-focus]") || isTextEntry(target)) return;
    // The field that keeps the focus never blurs, so its typed value is taken now: the press may retarget its panel
    editor.drafts.commitAll();
    event.preventDefault();
    // A press in another panel makes that panel the focused one (its pointer-down already set it): the element that
    // had the focus there (a Project row that keeps its arrows) lets it go, so the shortcuts reach the pressed panel
    const panel = control.closest("[data-editor-panel]");
    const active = control.ownerDocument.activeElement;
    if (panel && active instanceof HTMLElement && !panel.contains(active)) active.blur();
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => onKey(event);
    const press = (event: MouseEvent) => onPress(event);
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", press, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", press, true);
    };
  }, []);
}
