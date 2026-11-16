// The editing state of a project, one instance for the whole Video Studio (mounted by EditorProvider): the timeline
// document and its commands with history, selection (clips, a transition or a caption: one at a time), tools, track
// targeting, the clipboard (useEditorClipboard) and the source loaded in the Source monitor. The Shots and the Edit
// workspace read and change the same instance.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { StudioShot, StudioTimeline, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { exportGeometry, localId } from "../model/project";
import type { StudioContextValue } from "../studioContext";
import { errorText } from "../swap/errors";
import { isGenerated } from "./adjustment";
import { createAdjustmentLayer } from "./adjustmentLayer";
import { executeEdit, type EditCommand } from "./commands";
import type { SourceDrag } from "./dragSource";
import { onlyTrackSwitches, type createEditHistory } from "./history";
import { commandLabel } from "./historyLabels";
import { clipEnabled, clipEnd, MAX_TIMELINE_TRACKS, selectClips, timelineDuration, trackClips, withEnabled, type TimelineResult } from "./model";
import { sortedCaptions, withoutCaption } from "./panels/captions/captionEdits";
import { removeShotClips } from "./shotRemoval";
import { dropTracks, placeEdit, type PlaceEdit, type PlaceMode } from "./sourceDrop";
import { sourceRange } from "./sourceMarks";
import { projectSources, shorterTakes, shotClips, shotSource, type ShorterTake } from "./sources";
import { createTextLayer } from "./textLayer";
import { primaryVideoTrack } from "./timelineGeometry";
import { useEditorClipboard } from "./useEditorClipboard";
import { timelineProblem } from "./validation";

export type EditorTool = "select" | "razor" | "ripple" | "roll" | "slip" | "slide";
export type { PlaceMode };

/** A drop that can be made: the edit, where it starts and how long it is, and the tracks it lands on. */
export interface DropPlan extends PlaceEdit {
  source: TimelineSource;
  start: number;
  length: number;
  trackIds: string[];
}

export interface EditorStateInput {
  studio: StudioContextValue;
  timeline: StudioTimeline;
  /** Why the project's timeline cannot be built; the timeline is then an empty stand-in and edits are refused. */
  problem: string | null;
  history: ReturnType<typeof createEditHistory>;
}

/** The clip a shot selection lands on: its video clip under the playhead, else its first one. */
function shotClip(timeline: StudioTimeline, shotId: string | null, frame: number): TimelineClip | null {
  if (!shotId) return null;
  const video = shotClips(timeline, shotId).filter((clip) => timeline.tracks.find((track) => track.track_id === clip.track_id)?.kind === "video");
  return video.find((clip) => clip.start_frame <= frame && frame < clipEnd(clip)) ?? video[0] ?? null;
}

/** Project media and the timeline's own sources as one list: a shot's take that the timeline already binds is listed once. */
function mergedSources(project: StudioContextValue["project"], timeline: StudioTimeline): TimelineSource[] {
  const bound = new Map(timeline.sources.filter((source) => source.shot_id).map((source) => [`${source.shot_id}/${source.take_id ?? ""}`, source]));
  const used = new Set<string>();
  const out: TimelineSource[] = [];
  for (const source of projectSources({ ...project, format: { ...project.format, fps: timeline.fps } })) {
    const existing = timeline.sources.find((item) => item.source_id === source.source_id) ?? (source.shot_id ? bound.get(`${source.shot_id}/${source.take_id ?? ""}`) : undefined);
    const item = existing ?? source;
    if (used.has(item.source_id)) continue;
    used.add(item.source_id);
    out.push(item);
  }
  for (const source of timeline.sources) if (!used.has(source.source_id)) out.push(source);
  return out;
}

export function useEditorState({ studio, timeline, problem, history }: EditorStateInput) {
  const { project, dispatch, notify, playhead, selectedShotId, selectShot, setMonitorMode, runTimelineCommands } = studio;
  const latest = useRef(timeline);
  useLayoutEffect(() => {
    latest.current = timeline;
  }, [timeline]);
  useSyncExternalStore(history.subscribe, history.snapshot);
  const [selected, setSelectedIds] = useState<string[]>(() => {
    const clip = shotClip(timeline, selectedShotId, playhead.getFrame());
    return clip ? [clip.clip_id] : [];
  });
  const [selectedTransition, setSelectedTransition] = useState<string | null>(null);
  // A caption on the caption track: shared with the Captions panel (one selection, as in Premiere)
  const [captionId, setCaptionId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(() => timeline.clips.find((clip) => clip.clip_id === selected[0])?.source_id ?? null);
  const [videoTarget, setVideoTarget] = useState("");
  const [audioTarget, setAudioTarget] = useState("");
  const [patchVideo, setPatchVideo] = usePersistentFlag("studio.nle.patch.video", true);
  const [patchAudio, setPatchAudio] = usePersistentFlag("studio.nle.patch.audio", true);
  const [untargeted, setUntargeted] = useState<ReadonlySet<string>>(() => new Set());
  // The shorter take the user was asked about (ShorterTakeDialog): applying it cannot be undone
  const [shorterAsked, requestShorter] = useState<ShorterTake | null>(null);
  const [linked, setLinked] = usePersistentFlag("studio.nle.linked", true);
  const [snapping, setSnapping] = usePersistentFlag("studio.nle.snap", true);
  const [proxy, setProxy] = usePersistentFlag("studio.nle.proxy", false);
  const [tool, setTool] = useState<EditorTool>("select");
  const sources = useMemo(() => mergedSources(project, timeline), [project, timeline]);
  const shorter = useMemo(() => shorterTakes(project, timeline), [project, timeline]);
  const seenGeneration = useRef(studio.documentGeneration);
  useEffect(() => {
    const replaced = seenGeneration.current !== studio.documentGeneration;
    seenGeneration.current = studio.documentGeneration;
    history.reconcile(project.timeline ?? null, replaced);
  }, [project.timeline, studio.documentGeneration, history]);
  // A step recorded while a shot existed would bring back its clips and source: forget the steps when a shot leaves
  const knownShots = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const present = new Set(project.shots.map((shot) => shot.shot_id));
    if ([...knownShots.current].some((shotId) => !present.has(shotId))) history.clear();
    knownShots.current = present;
  }, [project.shots, history]);

  const warn = (error: string) => notify({ tone: "warning", title: t("無法套用剪輯"), detail: error });

  /**
   * Writes an edited document as one history step; `label` names the step (default: what the documents show). With
   * `step` false it is written without one (a track switch): saved like any edit, never undone.
   */
  const commit = (next: StudioTimeline, label?: string, step = true): boolean => {
    if (problem) {
      warn(problem);
      return false;
    }
    if (latest.current !== timeline) {
      warn(t("剪輯已更新，請重新套用這次操作"));
      return false;
    }
    const invalid = timelineProblem(next);
    if (invalid) {
      warn(invalid);
      return false;
    }
    const unchanged = JSON.stringify(timeline) === JSON.stringify(next);
    if (unchanged && project.timeline) return true;
    if (!unchanged && step) history.record(timeline, next, label);
    else if (!unchanged) history.adopt(next);
    dispatch({ type: "setTimeline", timeline: next });
    return true;
  };

  const command = (edit: EditCommand): boolean => {
    if (problem) {
      warn(problem);
      return false;
    }
    const result = executeEdit(timeline, edit);
    if (!result.ok) {
      warn(result.error);
      return false;
    }
    const label = commandLabel(edit) ?? undefined;
    if (edit.type === "rangeDelete") {
      const { work_area: _area, ...next } = result.value;
      return commit(next, label);
    }
    return commit(result.value, label, !(edit.type === "patchTrack" && onlyTrackSwitches(edit.patch)));
  };

  const travel = (step: "undo" | "redo") => {
    const result = step === "undo" ? history.undo(timeline) : history.redo(timeline);
    if (result?.ok) dispatch({ type: "setTimeline", timeline: result.value });
    else if (result) warn(result.error);
  };
  /** Undo or redo until `position` steps of the history are applied (the History panel's list). */
  const travelTo = (position: number) => {
    const result = history.travel(timeline, position);
    if (!result) return;
    dispatch({ type: "setTimeline", timeline: result.timeline });
    if (result.error) warn(result.error);
  };

  const trackOf = (clip: TimelineClip | null | undefined): TimelineTrack | null => timeline.tracks.find((track) => track.track_id === clip?.track_id) ?? null;
  const sourceOf = (clip: TimelineClip | null | undefined): TimelineSource | null => sources.find((source) => source.source_id === clip?.source_id) ?? null;

  /** Selection never changes a tab or a layout; it loads the clip's media as the source and follows its shot. */
  const follow = (clipId: string | undefined) => {
    const source = sourceOf(timeline.clips.find((item) => item.clip_id === clipId));
    if (source && !isGenerated(source)) setSourceId(source.source_id);
    if (source?.shot_id && source.shot_id !== selectedShotId) selectShot(source.shot_id, { fromClip: true });
  };
  const select = (id: string, extend = false) => {
    setSelectedTransition(null);
    setCaptionId(null);
    setSelectedIds((ids) => (extend ? (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]) : [id]));
    follow(id);
  };
  const setSelected = (ids: string[]) => {
    setSelectedTransition(null);
    setCaptionId(null);
    setSelectedIds(ids);
    follow(ids[0]);
  };
  const selectTransition = (clipId: string | null) => {
    setSelectedTransition(clipId);
    if (!clipId) return;
    setSelectedIds([]);
    setCaptionId(null);
  };
  /** Selecting a caption (on the caption track or in the Captions panel) takes the place of any other selection. */
  const selectCaption = (id: string | null) => {
    setCaptionId(id);
    if (!id) return;
    setSelectedIds([]);
    setSelectedTransition(null);
  };
  // A caption that an undo or an import took away is no selection
  const selectedCaption = captionId !== null && timeline.captions.some((caption) => caption.caption_id === captionId) ? captionId : null;
  /** A shot was selected in the Shots workspace: its clip under the playhead (else its first) becomes the selection. */
  const selectShotClip = (shotId: string | null) => {
    const current = timeline.clips.find((clip) => clip.clip_id === selected[0]);
    if (shotId && sourceOf(current)?.shot_id === shotId) return;
    const clip = shotClip(timeline, shotId, playhead.getFrame());
    setSelectedTransition(null);
    setCaptionId(null);
    setSelectedIds(clip ? [clip.clip_id] : []);
    if (clip) setSourceId(clip.source_id);
  };

  const patchTrack = (kind: "video" | "audio") => {
    const wanted = kind === "video" ? videoTarget : audioTarget;
    const peers = timeline.tracks.filter((track) => track.kind === kind);
    return peers.find((track) => track.track_id === wanted) ?? peers[0];
  };

  /** Runs a place edit as one step; the new clips become the selection. */
  const runPlace = (edit: PlaceEdit): boolean => {
    const result = executeEdit(edit.timeline, edit.command);
    if (!result.ok) {
      warn(result.error);
      return false;
    }
    if (!commit(result.value, commandLabel(edit.command) ?? undefined)) return false;
    setSelected(edit.clipIds);
    return true;
  };
  /** Puts a source range on the given tracks at a frame. */
  const placeOn = (source: TimelineSource, inFrame: number, outFrame: number, mode: PlaceMode, at: number, tracks: readonly TimelineTrack[]): boolean =>
    runPlace(placeEdit(timeline, source, inFrame, outFrame, mode, at, tracks, localId));

  /**
   * Three-point edit from the Source monitor: the marked range lands on the source-patched tracks at the sequence In
   * point when one is set, else at the playhead.
   */
  const place = (source: TimelineSource, inFrame: number, outFrame: number, mode: PlaceMode): boolean => {
    const wanted = [...(patchVideo && source.kind !== "audio" ? [patchTrack("video")] : []), ...(patchAudio && (source.kind === "audio" || source.has_audio) ? [patchTrack("audio")] : [])];
    if (wanted.length === 0) {
      warn(t("來源修補都關閉了；請在軌道標頭開啟視訊或音訊的來源修補"));
      return false;
    }
    const tracks = wanted.flatMap((track) => (track ? [track] : []));
    if (tracks.length !== wanted.length) {
      warn(t("請先新增對應的視訊軌或音訊軌"));
      return false;
    }
    return placeOn(source, inFrame, outFrame, mode, timeline.work_area?.start_frame ?? playhead.getFrame(), tracks);
  };

  /**
   * Where a dragged source would land when it is released over a track (null: over no track) at a frame: the marked
   * range, or the one remembered for the source, on the track under the pointer and its pair of the other kind.
   */
  const planDrop = (drag: SourceDrag, trackId: string | null, at: number, mode: PlaceMode): TimelineResult<DropPlan> => {
    if (problem) return { ok: false, error: problem };
    const source = sources.find((item) => item.source_id === drag.sourceId && !isGenerated(item));
    if (!source) return { ok: false, error: t("這個素材已經不在專案裡") };
    const marked = drag.inFrame !== null && drag.outFrame !== null && drag.inFrame < drag.outFrame && drag.outFrame <= source.duration_frames;
    const range = marked ? { inFrame: drag.inFrame ?? 0, outFrame: drag.outFrame ?? 0 } : sourceRange(project.project_id, source, timeline.fps);
    const tracks = dropTracks(timeline, source, { trackId, video: patchTrack("video"), audio: patchTrack("audio") });
    if (!tracks.ok) return tracks;
    const start = Math.max(0, at);
    const edit = placeEdit(timeline, source, range.inFrame, range.outFrame, mode, start, tracks.value, localId);
    return { ok: true, value: { ...edit, source, start, length: range.outFrame - range.inFrame, trackIds: tracks.value.map((track) => track.track_id) } };
  };
  /** Releases a dragged source on the timeline: overwrite, or insert (everything after it moves right). */
  const dropSource = (drag: SourceDrag, trackId: string | null, at: number, mode: PlaceMode): boolean => {
    const plan = planDrop(drag, trackId, at, mode);
    if (!plan.ok) {
      warn(plan.error);
      return false;
    }
    if (!runPlace(plan.value)) return false;
    setSourceId(plan.value.source.source_id);
    return true;
  };

  /** A shot's whole take (or its placeholder) at the end of the film: first video track and, with sound, first audio track. */
  const appendShot = (source: TimelineSource): boolean => {
    const video = primaryVideoTrack(timeline);
    const audio = source.has_audio ? timeline.tracks.find((track) => track.kind === "audio") : undefined;
    if (!video) {
      warn(t("請先新增對應的視訊軌或音訊軌"));
      return false;
    }
    const end = Math.max(0, ...trackClips(timeline, video.track_id).map(clipEnd), ...(audio ? trackClips(timeline, audio.track_id).map(clipEnd) : []));
    return placeOn(source, 0, source.duration_frames, "overwrite", end, audio ? [video, audio] : [video]);
  };

  const patchClip = (clip: TimelineClip): boolean => {
    const previous = timeline.clips.find((item) => item.clip_id === clip.clip_id);
    if (!previous) return false;
    if (clip.start_frame !== previous.start_frame) return command({ type: "move", clipId: clip.clip_id, trackId: clip.track_id, startFrame: clip.start_frame, linked });
    if (clip.in_frame !== previous.in_frame || clip.out_frame !== previous.out_frame) {
      const edge = clip.in_frame !== previous.in_frame ? "in" : "out";
      const moved = edge === "in" ? clip.in_frame - previous.in_frame : clip.out_frame - previous.out_frame;
      return command({ type: "trim", clipId: clip.clip_id, edge, delta: (moved * 100) / (previous.effects?.speed_percent ?? 100), linked });
    }
    const patch = { name: clip.name, effects: clip.effects, motion: clip.motion, effect_stack: clip.effect_stack, mask: clip.mask, blend_mode: clip.blend_mode };
    return command({ type: "patchClip", clipId: clip.clip_id, linked, patch });
  };

  /**
   * Removes a caption as one step. When it was the selected one, the caption after it (else the one before it) takes
   * the selection, so Delete can go on.
   */
  const removeCaption = (id: string): boolean => {
    const ordered = sortedCaptions(timeline.captions);
    const at = ordered.findIndex((caption) => caption.caption_id === id);
    if (at < 0) return false;
    const next = ordered[at + 1] ?? ordered[at - 1] ?? null;
    if (!commit(withoutCaption(timeline, id), t("刪除字幕"))) return false;
    if (id === selectedCaption) setCaptionId(next?.caption_id ?? null);
    return true;
  };
  /** Delete acts on the one selection: the selected caption, transition or clips. */
  const remove = (ripple: boolean) => {
    if (selectedCaption) return removeCaption(selectedCaption);
    if (selectedTransition) return command({ type: "transition", clipId: selectedTransition, kind: "cut", frames: 0, linked });
    return command({ type: "delete", clipIds: selected, ripple, linked });
  };

  const markRange = (edge: "in" | "out") => {
    const total = timelineDuration(timeline);
    if (total === 0) {
      warn(t("時間軸沒有可設定範圍的內容"));
      return;
    }
    const at = Math.max(0, Math.min(total - 1, playhead.getFrame()));
    const area = timeline.work_area ?? { start_frame: 0, end_frame: total };
    const next = edge === "in" ? { start_frame: at, end_frame: Math.min(total, Math.max(at + 1, area.end_frame)) } : { start_frame: Math.min(area.start_frame, at), end_frame: at + 1 };
    commit({ ...timeline, work_area: next });
  };
  const clearWorkArea = () => {
    const { work_area: _area, ...next } = timeline;
    commit(next);
  };
  const removeRange = (ripple: boolean) => {
    const area = timeline.work_area;
    if (!area || area.end_frame > timelineDuration(timeline)) {
      warn(t("請先設定有效的序列入出點；匯出範圍不得超過序列長度"));
      return;
    }
    command({ type: "rangeDelete", startFrame: area.start_frame, endFrame: area.end_frame, ripple });
  };

  const targets = new Set(timeline.tracks.filter((track) => !untargeted.has(track.track_id)).map((track) => track.track_id));
  const clipboard = useEditorClipboard({ timeline, selected, linked, targets, playhead, commit, warn, notify, setSelected, setMonitorMode, lift: () => remove(false), trackOf });
  const toggleTarget = (trackId: string) => {
    const next = new Set(untargeted);
    if (next.has(trackId)) next.delete(trackId);
    else next.add(trackId);
    setUntargeted(next);
  };
  /** Add an edit at the playhead: on the selected clips, else on every clip under the playhead of the targeted (or all) tracks. */
  const split = (allTracks = false) => {
    const frame = playhead.getFrame();
    const under = timeline.clips.filter((clip) => frame > clip.start_frame && frame < clipEnd(clip) && (allTracks || targets.has(clip.track_id)) && trackOf(clip)?.locked === false);
    const ids = selected.length > 0 && !allTracks ? selected : under.map((clip) => clip.clip_id);
    return command({ type: "split", clipIds: ids, frame, linked });
  };

  const addMarker = () => commit({ ...timeline, markers: [...timeline.markers, { marker_id: localId("marker"), frame: playhead.getFrame(), name: t("新標記"), color: "blue" }] });
  const addTrack = (kind: TimelineTrack["kind"]) => {
    const names = new Set(timeline.tracks.map((track) => track.name));
    const prefix = kind === "video" ? "V" : "A";
    let number = 1;
    while (names.has(`${prefix}${number}`)) number += 1;
    return command({ type: "addTrack", kind, name: `${prefix}${number}` });
  };
  const canAddTrack = timeline.tracks.length < MAX_TIMELINE_TRACKS;
  /** A generated layer (a text, an adjustment layer) at the playhead: the new clip becomes the selection. */
  const addLayer = (create: typeof createTextLayer) => {
    const { width, height } = exportGeometry(project);
    const result = create(timeline, playhead.getFrame(), width, height, localId);
    if (!result.ok) {
      warn(result.error);
      return;
    }
    if (commit(result.value.timeline)) {
      setSelected([result.value.clipId]);
      setMonitorMode("program");
    }
  };
  const addTextLayer = () => addLayer(createTextLayer);
  /** An adjustment layer at the playhead over everything that plays there (adjustmentLayer.ts). */
  const addAdjustmentLayer = () => addLayer(createAdjustmentLayer);

  /** Whether a shot plays in the film: it has a clip on the timeline. */
  const shotInTimeline = (shotId: string) => shotClips(timeline, shotId).length > 0;
  /**
   * A shot the user just added joins the end of the film at once: its take, or a placeholder of the planned length
   * until it is rendered. The Controller gives a shot made elsewhere its place in the same way when the project is
   * saved. A duplicated shot starts off the timeline instead (its copy is not enabled).
   */
  const placeShot = (shot: StudioShot): boolean => {
    if (problem) return false;
    return appendShot(shotSource(project, shot, timeline.fps));
  };
  /**
   * Add a shot to the timeline (its take, or a placeholder of the planned length, at the end of the film) or take it
   * off (its clips are removed and the following clips close up; a gap stays where a sync-locked clip spans the
   * place). Its source stays on the timeline, so the shot is not placed again by itself.
   */
  const setShotInTimeline = (shotId: string, on: boolean): boolean => {
    const shot = project.shots.find((item) => item.shot_id === shotId);
    if (!shot || problem) return false;
    if (on === shotInTimeline(shotId)) return true;
    if (!on) {
      const removed = removeShotClips(timeline, shotId);
      if (!removed.ok) {
        warn(removed.error);
        return false;
      }
      if (!commit(removed.value.timeline)) return false;
      if (!removed.value.rippled) notify({ tone: "info", title: t("已移出時間軸，原位置留下空隙"), detail: t("同步鎖定的軌道有片段跨越這裡，所以後面的片段沒有往前接上。") });
    } else {
      if (!appendShot(timeline.sources.find((item) => item.shot_id === shotId) ?? shotSource(project, shot, timeline.fps))) return false;
    }
    return true;
  };
  /** Move a shot's clips (its block on the first video track) before / after another shot's block: a rearrange edit. */
  const rearrangeShot = (shotId: string, targetShotId: string | null, side: "before" | "after"): boolean => {
    const track = primaryVideoTrack(timeline);
    if (!track) return false;
    const onTrack = (id: string) => shotClips(timeline, id).filter((clip) => clip.track_id === track.track_id);
    const block = onTrack(shotId);
    const anchors = targetShotId ? onTrack(targetShotId) : [];
    const anchor = side === "before" ? anchors[0] : anchors.at(-1);
    if (block.length === 0 || (targetShotId !== null && !anchor)) return false;
    return command({ type: "rearrange", clipIds: block.map((clip) => clip.clip_id), targetId: anchor?.clip_id ?? null, side, linked: true });
  };
  /**
   * Use the shot's shorter active take. The Controller applies it (the reconcile command): the clips that reach
   * beyond the new media are ripple-trimmed to it and the source is bound to the take. The edit history starts over,
   * because its earlier steps describe clips of media that is no longer bound.
   */
  const applyShorter = async (pending: ShorterTake): Promise<boolean> => {
    try {
      await runTimelineCommands([{ op: "reconcile", source_id: pending.sourceId }]);
      return true;
    } catch (error) {
      warn(errorText(error));
      return false;
    }
  };

  /** Switch the selected clips off or on: a switched-off clip keeps its place but neither plays nor exports. */
  const toggleEnabled = (): boolean => {
    const ids = new Set(selectClips(timeline, selected, linked).map((clip) => clip.clip_id));
    if (ids.size === 0) {
      warn(t("請先選取片段"));
      return false;
    }
    const on = timeline.clips.some((clip) => ids.has(clip.clip_id) && !clipEnabled(clip));
    return commit({ ...timeline, clips: timeline.clips.map((clip) => (ids.has(clip.clip_id) ? withEnabled(clip, on) : clip)) });
  };

  const selectedClip = timeline.clips.find((clip) => clip.clip_id === selected[0]) ?? null;
  const media = sources.filter((source) => !isGenerated(source));
  return {
    problem,
    /** Whether the project has a saved timeline (otherwise it is derived from the shot sequence until the first edit). */
    saved: project.timeline !== undefined,
    timeline,
    fps: timeline.fps.num / timeline.fps.den,
    totalFrames: timelineDuration(timeline),
    sources,
    source: media.find((source) => source.source_id === sourceId) ?? media[0] ?? null,
    setSourceId,
    sourceOf,
    trackOf,
    selected,
    select,
    setSelected,
    selectedClip,
    selectedTransition,
    selectTransition,
    /** The selected caption; null when a clip, a transition or nothing is selected. */
    selectedCaption,
    selectCaption,
    removeCaption,
    selectShotClip,
    patchVideo,
    patchAudio,
    setPatchVideo,
    setPatchAudio,
    videoTarget: patchTrack("video")?.track_id ?? "",
    audioTarget: patchTrack("audio")?.track_id ?? "",
    setVideoTarget,
    setAudioTarget,
    targets,
    toggleTarget,
    linked,
    setLinked,
    snapping,
    setSnapping,
    proxy,
    setProxy,
    tool,
    setTool,
    command,
    commit,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
    historyDepth: history.depth(),
    history: history.steps(),
    travelTo,
    forgetHistory: () => history.clear(),
    place,
    planDrop,
    dropSource,
    ...clipboard,
    markRange,
    clearWorkArea,
    removeRange,
    remove,
    split,
    patchClip,
    toggleEnabled,
    /** Why clips cannot be switched off in this document; null when they can. */
    addMarker,
    addTrack,
    canAddTrack,
    addTextLayer,
    addAdjustmentLayer,
    shotInTimeline,
    setShotInTimeline,
    placeShot,
    rearrangeShot,
    shorterTakes: shorter,
    shorterAsked,
    requestShorter,
    applyShorter,
    warn,
  };
}

export type EditorState = ReturnType<typeof useEditorState>;
