// The clipboard of the editor (part of the editing state, see useEditorState): copy, cut, paste (an overwrite at the
// playhead on the targeted tracks), paste insert, paste attributes and duplicate. Every paste is one step of the
// history, named as Premiere names it; after a paste the new clips are selected and the playhead stands after them.
import { useState } from "react";
import type { StudioTimeline, TimelineClip, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { PlayheadStore } from "../hooks/playhead";
import { localId } from "../model/project";
import type { MonitorMode, StudioContextValue } from "../studioContext";
import { copyClips, ownTracks, pasteClips, pasteTracks, type ClipClipboard } from "./clipboard";
import { clipEnd, selectClips } from "./model";
import { attributeChoices, pasteAttributes as pasteChosen, type AttributeChoice, type PasteAttribute } from "./pasteAttributes";
import type { PlaceMode } from "./sourceDrop";

export interface ClipboardInput {
  timeline: StudioTimeline;
  selected: string[];
  linked: boolean;
  targets: ReadonlySet<string>;
  playhead: PlayheadStore;
  commit: (next: StudioTimeline, label?: string) => boolean;
  warn: (error: string) => void;
  notify: StudioContextValue["notify"];
  setSelected: (ids: string[]) => void;
  setMonitorMode: (mode: MonitorMode) => void;
  /** Removes the selection, leaving its place empty (cut). */
  lift: () => boolean;
  trackOf: (clip: TimelineClip | null | undefined) => TimelineTrack | null;
}

export function useEditorClipboard(input: ClipboardInput) {
  const { timeline, selected, linked, targets, playhead, commit, warn, notify, setSelected, setMonitorMode, lift, trackOf } = input;
  const [clipboard, setClipboard] = useState<ClipClipboard | null>(null);

  const copy = (): boolean => {
    const result = copyClips(timeline, selected, linked);
    if (!result.ok) {
      warn(result.error);
      return false;
    }
    setClipboard(result.value);
    notify({ tone: "success", title: t("已複製 {count} 個片段", { count: result.value.clips.length }) });
    return true;
  };
  /** Cut = copy, then lift the clips (the space they leave stays). */
  const cut = () => {
    if (copy()) lift();
  };

  // Where a paste would land, and why it cannot (reported by the keys and shown in the menus)
  const landing = clipboard ? pasteTracks(timeline, clipboard, targets) : null;
  const destinations = landing?.ok ? [...landing.value.values()] : [];
  const pasteBlocked = !clipboard
    ? t("請先複製時間軸片段")
    : landing && !landing.ok
      ? landing.error
      : destinations.some((trackId) => timeline.tracks.find((track) => track.track_id === trackId)?.locked)
        ? t("軌道已鎖定；請先解鎖再編輯")
        : null;

  /** Ctrl/⌘+V overwrites at the playhead, Ctrl/⌘+Shift+V inserts there; on the targeted tracks either way. */
  const paste = (mode: PlaceMode = "overwrite") => {
    if (!clipboard || !landing) {
      warn(t("請先複製時間軸片段"));
      return;
    }
    if (!landing.ok) {
      warn(landing.error);
      return;
    }
    const result = pasteClips(timeline, clipboard, playhead.getFrame(), mode, landing.value);
    if (!result.ok) {
      warn(result.error);
      return;
    }
    if (!commit(result.value.timeline, mode === "insert" ? t("貼上插入") : t("貼上"))) return;
    setSelected(result.value.selected);
    playhead.setPlaying(false);
    playhead.setFrame(result.value.end);
    setMonitorMode("program");
  };

  /** A copy of the selection right after it, on the same tracks; what follows moves right. */
  const duplicate = () => {
    const copied = copyClips(timeline, selected, linked);
    if (!copied.ok) {
      warn(copied.error);
      return;
    }
    const result = pasteClips(timeline, copied.value, Math.max(...selectClips(timeline, selected, linked).map(clipEnd)), "insert", ownTracks(copied.value));
    if (!result.ok) {
      warn(result.error);
      return;
    }
    if (!commit(result.value.timeline, t("複製一份"))) return;
    setSelected(result.value.selected);
    setMonitorMode("program");
  };

  /** What Paste Attributes offers for the selection; null when there is nothing to paste or nothing to paste onto. */
  const attributesBlocked = !clipboard ? t("請先複製時間軸片段") : selected.length === 0 ? t("請先選取要貼上屬性的片段") : null;
  const pasteAttributeChoices = (): AttributeChoice[] => (clipboard ? attributeChoices(timeline, clipboard, selected, linked) : []);
  /** Pastes the chosen attributes; the reason it was refused (for the dialog to show), or null once it is done. */
  const pasteAttributes = (chosen: ReadonlySet<PasteAttribute>): string | null => {
    if (!clipboard) return t("請先複製時間軸片段");
    const result = pasteChosen(timeline, clipboard, selected, linked, chosen, localId);
    if (!result.ok) return result.error;
    // A document that changed meanwhile is reported by commit itself, after the dialog has closed
    commit(result.value.timeline, t("貼上屬性"));
    return null;
  };

  const unlocked = (clips: readonly TimelineClip[]) => clips.every((clip) => trackOf(clip)?.locked === false);
  const canCopy = selected.length > 0 && selected.every((id) => timeline.clips.some((clip) => clip.clip_id === id));
  return {
    /** What was copied last (the source of Paste Attributes); null before the first copy. */
    clipboard,
    copy,
    cut,
    paste,
    duplicate,
    canCopy,
    canDuplicate: canCopy && unlocked(selectClips(timeline, selected, linked)),
    /** Why a paste cannot be made now; null when it can. */
    pasteBlocked,
    attributesBlocked,
    pasteAttributeChoices,
    pasteAttributes,
  };
}
