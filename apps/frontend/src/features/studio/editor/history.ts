import type { StudioTimeline, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { changeLabel } from "./historyLabels";
import type { TimelineResult } from "./model";
import { timelineProblem } from "./validation";

/**
 * The track header's switches (lock, sync lock, output / mute, solo) are the state of the panel, not edits: as in
 * Premiere they never become a step of the history, are saved with the document, and undo or redo leaves them as
 * they are.
 */
const TRACK_SWITCHES = ["locked", "sync_lock", "muted", "solo"] as const satisfies readonly (keyof TimelineTrack)[];

/** Whether a track patch only flips the track's switches (no step of the history). */
export function onlyTrackSwitches(patch: Partial<TimelineTrack>): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => (TRACK_SWITCHES as readonly string[]).includes(key));
}

function liveSwitches(track: TimelineTrack, live: StudioTimeline): TimelineTrack {
  const current = live.tracks.find((item) => item.track_id === track.track_id);
  if (!current) return track;
  const next = { ...track };
  for (const key of TRACK_SWITCHES) next[key] = current[key];
  return next;
}

/**
 * A step that comes back is the edit it recorded, on today's facts. Async results for the same media (a playback
 * proxy), the track switches and the Controller's bookkeeping (the shots that were given a place, the migration notes)
 * are not edits: the snapshot takes them from the live document. A source that showed other media, or none yet, stays as the snapshot
 * had it, with the clip lengths that belong to it; the Controller brings it to the shot's current take, and lets
 * whole-take clips follow, when the step is saved.
 */
function restore(snapshot: StudioTimeline, live: StudioTimeline): StudioTimeline {
  const { placed_shot_ids: _placed, migration_notes: _notes, ...edit } = snapshot;
  return {
    ...edit,
    ...(live.placed_shot_ids ? { placed_shot_ids: live.placed_shot_ids } : {}),
    ...(live.migration_notes ? { migration_notes: live.migration_notes } : {}),
    tracks: snapshot.tracks.map((track) => liveSwitches(track, live)),
    sources: snapshot.sources.map((source) => {
      const current = live.sources.find((item) => item.source_id === source.source_id);
      return current && source.file && current.file?.sha256 === source.file.sha256 ? { ...source, ...current } : source;
    }),
  };
}
function rebound(before: StudioTimeline, after: StudioTimeline): boolean {
  return before.sources.some((source) => {
    const current = after.sources.find((item) => item.source_id === source.source_id);
    return current && (source.kind !== current.kind || source.library_id !== current.library_id || source.shot_id !== current.shot_id || (source.take_id && source.take_id !== current.take_id) || (source.file && source.file.sha256 !== current.file?.sha256));
  });
}
/** What of a document is the edit: not the media facts of its sources and not the Controller's bookkeeping. */
function editSignature(timeline: StudioTimeline): string {
  const { placed_shot_ids: _placed, migration_notes: _notes, ...edit } = timeline;
  return JSON.stringify({ ...edit, sources: timeline.sources.map((source) => ({ source_id: source.source_id })) });
}

/** One step of the history, as the History panel lists it. */
export interface HistoryStep {
  id: number;
  label: string;
}

interface Entry extends HistoryStep {
  /** For a step that can be undone: the document before it. For one that can be redone: the document after it. */
  timeline: StudioTimeline;
}

/** What the history says about the last edit, undo or redo (the editor's live region reads it); id tells two equal texts apart. */
export interface HistoryAnnouncement {
  id: number;
  text: string;
}

const MAX_STEPS = 80;

/** History owns edits only; render results and document revisions never enter it. */
export function createEditHistory() {
  let version = 0;
  let nextId = 1;
  let past: Entry[] = [];
  let future: Entry[] = [];
  let owned: StudioTimeline | null = null;
  let announcement: HistoryAnnouncement | null = null;
  let said = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const announce = (text: string) => {
    said += 1;
    announcement = { id: said, text };
  };
  const undo = (current: StudioTimeline): TimelineResult<StudioTimeline> | null => {
    const step = past.at(-1);
    if (!step) return null;
    const next = restore(step.timeline, current);
    const error = timelineProblem(next);
    if (error) return { ok: false, error };
    past = past.slice(0, -1);
    future = [...future, { ...step, timeline: current }];
    owned = next;
    emit();
    return { ok: true, value: next };
  };
  const redo = (current: StudioTimeline): TimelineResult<StudioTimeline> | null => {
    const step = future.at(-1);
    if (!step) return null;
    const next = restore(step.timeline, current);
    const error = timelineProblem(next);
    if (error) return { ok: false, error };
    future = future.slice(0, -1);
    past = [...past, { ...step, timeline: current }];
    owned = next;
    emit();
    return { ok: true, value: next };
  };
  return {
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => version,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    /** Steps that can be undone and redone. */
    depth: () => ({ undo: past.length, redo: future.length }),
    /** The last edit, undo or redo, as a sentence; null before the first one. */
    announcement: () => announcement,
    /**
     * Every step in the order it was made, and how many of them are applied: the steps before that position can be
     * undone (the last of them first), the ones from it on can be redone.
     */
    steps: (): { steps: HistoryStep[]; position: number } => ({
      steps: [...past, ...[...future].reverse()].map(({ id, label }) => ({ id, label })),
      position: past.length,
    }),
    /** Forget every step: snapshots must not bring back clips whose media was just deleted. */
    clear() {
      if (past.length === 0 && future.length === 0) return;
      past = [];
      future = [];
      emit();
    },
    /** Records an edit as one step; without a name the step is named after what the two documents show. */
    record(before: StudioTimeline, after: StudioTimeline, label?: string) {
      const name = label ?? changeLabel(before, after);
      past = [...past.slice(-(MAX_STEPS - 1)), { id: nextId, label: name, timeline: before }];
      nextId += 1;
      future = [];
      owned = after;
      announce(name);
      emit();
    },
    /** Takes a change that is not a step (a track switch) as this editor's own document; the steps stay. */
    adopt(after: StudioTimeline) {
      owned = after;
    },
    undo(current: StudioTimeline): TimelineResult<StudioTimeline> | null {
      const label = past.at(-1)?.label;
      const result = undo(current);
      if (result?.ok && label !== undefined) {
        announce(t("復原：{label}", { label }));
        emit();
      }
      return result;
    },
    redo(current: StudioTimeline): TimelineResult<StudioTimeline> | null {
      const label = future.at(-1)?.label;
      const result = redo(current);
      if (result?.ok && label !== undefined) {
        announce(t("重做：{label}", { label }));
        emit();
      }
      return result;
    },
    /**
     * Undo or redo until the given number of steps is applied. Answers the document it reached, with the reason when
     * a step on the way could not be restored (the document then stands at the last step that could); null when
     * nothing moved.
     */
    travel(current: StudioTimeline, position: number): { timeline: StudioTimeline; error: string | null } | null {
      const target = Math.max(0, Math.min(past.length + future.length, Math.trunc(position)));
      const back = past.length > target;
      let timeline = current;
      let moved = false;
      let error: string | null = null;
      while (past.length !== target) {
        const result = past.length > target ? undo(timeline) : redo(timeline);
        if (!result) break;
        if (!result.ok) {
          error = result.error;
          break;
        }
        timeline = result.value;
        moved = true;
      }
      if (!moved) return error === null ? null : { timeline, error };
      // One sentence for the whole way: the state it reached
      const label = past.at(-1)?.label ?? t("開啟時的狀態");
      announce(back ? t("復原到「{label}」", { label }) : t("重做到「{label}」", { label }));
      emit();
      return { timeline, error };
    },
    /**
     * The document changed without an edit of this editor (null: it has no timeline). `replaced` = it was loaded
     * from outside (a reload, a version saved elsewhere, a command the Controller ran): steps recorded on another
     * version cannot be reused unless the edit is the same. Otherwise it is the Controller's answer to this editor's
     * own save (a source bound to a new take, a clip that follows it, a new shot's place): the steps stay.
     */
    reconcile(current: StudioTimeline | null, replaced: boolean) {
      if (!owned || current === owned) return;
      if (current && (!replaced || (!rebound(owned, current) && editSignature(current) === editSignature(owned)))) {
        owned = current;
        return;
      }
      past = [];
      future = [];
      owned = current;
      emit();
    },
  };
}
