// The cut conform's parts as one timeline edit (pure; conform.ts plans the parts): the clips the parts become, the
// editor commands that make them — the clip split at every piece's edges, the take frames left out removed, then each
// piece retimed, moved, trimmed or slipped once the place it takes and every step on the way are free — and the take
// frame every clip frame shows afterwards, which the planner checks against its plan.
import type { MediaClipEffects, StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { executeEdit, type EditCommand } from "../editor/commands";
import { clipDuration, clipEnd, sourceFrameAtTimeline } from "../editor/model";

export type ConformTreatment =
  | { kind: "keep" }
  /** Take frame `at` shown `frames` more times (the stillest frame of the part). */
  | { kind: "hold"; frames: number; at: number }
  /** Take frames [from, from + length) played at `speed` %: `frames` fewer frames, skipped one at a time (the stillest window). */
  | { kind: "faster"; from: number; length: number; speed: number; frames: number }
  /** Single take frames left out, never two side by side (where no faster window fits). */
  | { kind: "drops"; frames: number[] }
  /**
   * After the last anchor the take keeps its speed: shift = that anchor's original − take frame; a late take (shift < 0)
   * holds its last frame `hold` = −shift frames. Frames from past the clip's end are never taken (extended is always
   * 0); withheld: the take has such frames, unused.
   */
  | { kind: "tail"; shift: number; extended: 0; hold: number; withheld?: true }
  /** After an early switch at the clip's end: the take's last `frames` frames of the clip (the next shot) are left out. */
  | { kind: "end"; frames: number };

export interface ConformSpan {
  /** Take frames that play (clip frames; after an early switch, the frames left out): [from, to). */
  take: { from: number; to: number };
  /** Where they play after the edit (clip frames): [from, to). */
  output: { from: number; to: number };
  treatment: ConformTreatment;
}

interface Piece {
  /** Take frames the piece holds once the clip is split (clip frames; the tail's reach the clip's end). */
  from: number;
  to: number;
  /** Its place after the edit (clip frames). */
  start: number;
  end: number;
  speed: number;
  hold: number;
  /** The part after the last anchor: its shift (frames its start moves later and its content slips back; a late one moves earlier and holds); null for the others. */
  tail: number | null;
}

export const plain = (piece: Piece) => piece.speed === 100 && piece.hold === 0 && (piece.tail ?? 0) === 0;

/** The clips the spans become, and the take frames left out (each removed as a clip of its own: a single frame, or the frames from an early switch on). */
export function piecesOf(spans: readonly ConformSpan[], length: number): { pieces: Piece[]; dropped: number[] } {
  const pieces: Piece[] = [];
  const dropped: number[] = [];
  const add = (piece: Piece) => {
    if (piece.to <= piece.from && piece.tail === null) return;
    const previous = pieces.at(-1);
    // Plain pieces that follow each other both in the take and on the sequence stay one clip
    if (previous && plain(previous) && plain(piece) && previous.to === piece.from && previous.end === piece.start) {
      previous.to = piece.to;
      previous.end = piece.end;
      previous.tail = piece.tail;
    } else pieces.push(piece);
  };
  const base = { speed: 100, hold: 0, tail: null };
  for (const { take, output, treatment } of spans) {
    switch (treatment.kind) {
      case "keep":
        add({ ...base, from: take.from, to: take.to, start: output.from, end: output.to });
        break;
      case "hold": {
        const split = treatment.at + 1;
        const end = output.from + split - take.from + treatment.frames;
        add({ ...base, from: take.from, to: split, start: output.from, end, hold: treatment.frames });
        add({ ...base, from: split, to: take.to, start: end, end: output.to });
        break;
      }
      case "faster": {
        const start = output.from + treatment.from - take.from;
        const end = start + treatment.length - treatment.frames;
        add({ ...base, from: take.from, to: treatment.from, start: output.from, end: start });
        add({ ...base, from: treatment.from, to: treatment.from + treatment.length, start, end, speed: treatment.speed });
        add({ ...base, from: treatment.from + treatment.length, to: take.to, start: end, end: output.to });
        break;
      }
      case "drops": {
        let cursor = take.from;
        let place = output.from;
        for (const frame of treatment.frames) {
          add({ ...base, from: cursor, to: frame, start: place, end: place + frame - cursor });
          place += frame - cursor;
          dropped.push(frame);
          cursor = frame + 1;
        }
        add({ ...base, from: cursor, to: take.to, start: place, end: output.to });
        break;
      }
      case "tail":
        add({ ...base, from: take.from, to: length, start: output.from, end: output.to, hold: treatment.hold, tail: treatment.shift });
        break;
      case "end":
        // The piece before ends at the switch: the frames from it to the clip's end go as one clip
        dropped.push(take.from);
        break;
    }
  }
  return { pieces, dropped };
}

/** The effects with the piece's speed and hold (speed 100 % is left out, as the editor writes it). */
function timedEffects(effects: MediaClipEffects | undefined, speed: number, hold: number): MediaClipEffects {
  const next: MediaClipEffects = { ...effects };
  if (speed === 100) delete next.speed_percent;
  else next.speed_percent = speed;
  if (hold > 0) next.hold = { ...effects?.hold, end: hold };
  return next;
}

interface Entry {
  piece: Piece;
  id: string;
  /** Sequence frames it covers now and where it goes. */
  now: { start: number; end: number };
  place: { start: number; end: number };
  done: boolean;
}

type EditOutcome = { ok: true; timeline: StudioTimeline; parts: TimelineClip[] } | { ok: false; reason: string };

/**
 * The pieces as editor commands: the clip is split at every piece's edges, the frames left out are removed, then each
 * piece is finished (retimed, moved, trimmed or slipped) once the place it takes and every step on the way is free —
 * a piece that grows moves first, one that shrinks is retimed in place first, an early tail keeps its end. Some piece
 * is always free: at each edge between two pieces, one of them can take its new place.
 */
export function applyPieces(timeline: StudioTimeline, clip: TimelineClip, pieces: readonly Piece[], dropped: readonly number[], linked: boolean): EditOutcome {
  let document = timeline;
  const run = (command: EditCommand): string | null => {
    const result = executeEdit(document, command);
    if (!result.ok) return result.error;
    document = result.value;
    return null;
  };
  const origin = clip.start_frame;
  const length = clipDuration(clip);
  const splits = new Set<number>(dropped);
  for (const piece of pieces) {
    if (piece.from > 0) splits.add(piece.from);
    if (piece.tail === null && piece.to < length) splits.add(piece.to);
  }
  // From the last edge backwards: the clip keeps its id as the first piece
  for (const frame of [...splits].sort((a, b) => b - a)) {
    const error = run({ type: "split", clipIds: [clip.clip_id], frame: origin + frame, linked });
    if (error) return { ok: false, reason: error };
  }
  const idAt = (frame: number) => document.clips.find((item) => item.track_id === clip.track_id && item.source_id === clip.source_id && item.start_frame === origin + frame)?.clip_id;
  const entries: Entry[] = [];
  for (const piece of pieces) {
    const id = idAt(piece.from);
    if (id === undefined) return { ok: false, reason: t("找不到分割後的片段") };
    entries.push({ piece, id, now: { start: origin + piece.from, end: origin + piece.to }, place: { start: origin + piece.start, end: origin + piece.end }, done: false });
  }
  const removed = dropped.map(idAt).filter((id) => id !== undefined);
  if (removed.length !== dropped.length) return { ok: false, reason: t("找不到分割後的片段") };
  if (removed.length > 0) {
    const error = run({ type: "delete", clipIds: removed, ripple: false, linked });
    if (error) return { ok: false, reason: error };
  }

  const finish = (entry: Entry): string | null => {
    const { piece, id } = entry;
    const move = () => (entry.place.start === entry.now.start ? null : run({ type: "move", clipId: id, startFrame: entry.place.start, trackId: clip.track_id, linked }));
    const retime = () => {
      if (piece.speed === 100 && piece.hold === 0) return null;
      const effects = timedEffects(document.clips.find((item) => item.clip_id === id)?.effects, piece.speed, piece.hold);
      return run({ type: "patchClip", clipId: id, patch: { effects }, linked });
    };
    // An early tail's start moves later and its content slips back by as much, so its end stays (a transition after it
    // keeps its overlap); any other piece that grows moves first, one that shrinks is retimed in place first (a late
    // tail grows: its last frame holds to the clip's end)
    const early = Math.max(0, piece.tail ?? 0);
    const keepEnd = () => run({ type: "trim", clipId: id, edge: "in", delta: early, ripple: false, linked }) ?? run({ type: "slip", clipId: id, delta: -early, linked });
    const grows = entry.place.end - entry.place.start > entry.now.end - entry.now.start;
    const steps = early > 0 ? [keepEnd] : grows ? [move, retime] : [retime, move];
    for (const step of steps) {
      const error = step();
      if (error) return error;
    }
    return null;
  };
  const fits = (index: number) => {
    const entry = entries[index];
    if (!entry || entry.done) return false;
    const left = entries[index - 1];
    const right = entries[index + 1];
    const leftEdge = left ? (left.done ? left.place.end : left.now.end) : Number.NEGATIVE_INFINITY;
    const rightEdge = right ? (right.done ? right.place.start : right.now.start) : Number.POSITIVE_INFINITY;
    return leftEdge <= entry.place.start && entry.place.end <= rightEdge;
  };
  for (let step = 0; step < entries.length; step += 1) {
    const entry = entries.find((_, index) => fits(index));
    if (!entry) return { ok: false, reason: t("找不到不重疊的套用順序") };
    const error = finish(entry);
    if (error) return { ok: false, reason: error };
    entry.done = true;
  }
  const parts: TimelineClip[] = [];
  for (const entry of entries) {
    const part = document.clips.find((item) => item.clip_id === entry.id);
    if (!part || part.start_frame !== entry.place.start || clipEnd(part) !== entry.place.end) return { ok: false, reason: t("對齊後的片段和計畫不一致") };
    parts.push(part);
  }
  return { ok: true, timeline: document, parts };
}

/** The take frame each clip frame shows in the edited clip (clip frames of the take; -1 where nothing plays). */
export function takeMapping(parts: readonly TimelineClip[], origin: number, first: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => {
    const frame = origin + offset;
    const part = parts.find((item) => item.start_frame <= frame && frame < clipEnd(item));
    return part ? sourceFrameAtTimeline(part, frame) - first : -1;
  });
}
