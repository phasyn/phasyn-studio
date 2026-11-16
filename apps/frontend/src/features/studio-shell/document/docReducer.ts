// Project document state shared by both Studios (pure): a local draft plus autosave with optimistic revision concurrency.
// Edits made while a save is in flight are kept and saved next with the new revision. A 409 conflict stops autosaving
// until the user decides: reload (drop local edits), overwrite (keep local edits on top of the server revision) or —
// when actions are tracked — rebase (re-apply the unsaved actions on the latest server version, a one-off merge the
// user asks for, never an automatic retry). Results of saves started before a reset or rebase are discarded.
// When the server's newest version, read after a conflict, already holds every unsaved edit (another tab wrote back the
// same render results), it simply becomes the saved state: nothing was lost and nothing is resent. A newer version
// saved elsewhere (another tab, an AI agent) replaces the document only while nothing is unsaved ("refresh").
import { valuesEqual } from "@/lib/json";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

/** Fields every Studio document has (contract StudioProject). */
export interface VersionedDoc {
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface PendingAction<TAction> {
  seq: number;
  action: TAction;
}

export interface DocState<TDoc, TAction> {
  base: TDoc;
  draft: TDoc;
  editSeq: number;
  savedSeq: number;
  status: SaveStatus;
  error: unknown;
  storedRevision: number | null;
  /** Actions with seq > savedSeq (only when tracking is on; rebase replays them). */
  pending: PendingAction<TAction>[];
  /** Bumped by reset and rebase: a save result carrying an older generation is ignored. */
  generation: number;
  /** The revision a refresh loaded (a version saved elsewhere while nothing here was unsaved); null otherwise. */
  refreshedRevision: number | null;
}

export type DocEvent<TDoc, TAction> =
  | { type: "edit"; action: TAction }
  | { type: "saveStart" }
  | { type: "saveOk"; saved: TDoc; seq: number; generation: number }
  | { type: "saveError"; error: unknown; generation: number }
  /** `latest`: the server's newest version, read after the conflict (when it could be read). */
  | { type: "conflict"; error: unknown; storedRevision: number | null; generation: number; latest?: TDoc }
  | { type: "reset"; doc: TDoc }
  /** Keep both sides: latest = the server's newest version. */
  | { type: "rebase"; latest: TDoc }
  /** A newer version saved elsewhere; taken only while nothing is unsaved. */
  | { type: "refresh"; doc: TDoc };

export type DocReducer<TDoc, TAction> = (state: DocState<TDoc, TAction>, event: DocEvent<TDoc, TAction>) => DocState<TDoc, TAction>;

export function initialDocState<TDoc, TAction>(doc: TDoc, generation = 0): DocState<TDoc, TAction> {
  return { base: doc, draft: doc, editSeq: 0, savedSeq: 0, status: "saved", error: null, storedRevision: null, pending: [], generation, refreshedRevision: null };
}

/**
 * The document reducer for one document type. `apply` is the pure edit reducer (returns the same object for a no-op);
 * `trackPending` keeps the unsaved actions: the conflict banner can offer "keep both" with them (only for incremental
 * actions), and a conflict whose server version already holds them all is no conflict.
 */
export function createDocReducer<TDoc extends VersionedDoc, TAction>(apply: (doc: TDoc, action: TAction) => TDoc, options: { trackPending?: boolean } = {}): DocReducer<TDoc, TAction> {
  const track = options.trackPending === true;
  return (state, event) => {
    switch (event.type) {
      case "edit": {
        const draft = apply(state.draft, event.action);
        if (draft === state.draft) return state;
        const seq = state.editSeq + 1;
        // Conflict and in-flight saves keep their status: the edit is saved after them
        const status: SaveStatus = state.status === "conflict" || state.status === "saving" ? state.status : "dirty";
        return { ...state, draft, editSeq: seq, status, pending: track ? [...state.pending, { seq, action: event.action }] : state.pending };
      }
      case "saveStart":
        return { ...state, status: "saving", error: null };
      case "saveOk": {
        if (event.generation !== state.generation) return state;
        const clean = state.editSeq === event.seq;
        // Edits after the save started stay in the draft, on top of the saved revision
        const draft = clean ? event.saved : { ...state.draft, revision: event.saved.revision, created_at: event.saved.created_at, updated_at: event.saved.updated_at };
        return {
          ...state,
          base: event.saved,
          draft,
          savedSeq: event.seq,
          status: clean ? "saved" : "dirty",
          error: null,
          storedRevision: null,
          pending: state.pending.filter((item) => item.seq > event.seq),
        };
      }
      case "saveError":
        return event.generation === state.generation ? { ...state, status: "error", error: event.error } : state;
      case "conflict": {
        if (event.generation !== state.generation) return state;
        // Replaying the unsaved actions on the server version changes nothing: it already holds them, so it is the saved
        // state (content equality: edit reducers may return a new object for a value that does not change)
        if (track && event.latest && valuesEqual(state.pending.reduce((doc, item) => apply(doc, item.action), event.latest), event.latest)) {
          return initialDocState(event.latest, state.generation + 1);
        }
        return { ...state, status: "conflict", error: event.error, storedRevision: event.storedRevision };
      }
      case "reset":
        return initialDocState(event.doc, state.generation + 1);
      case "refresh":
        // An edit or a save since the version was read keeps this one: its save then meets the conflict as before
        if (state.status !== "saved" || event.doc.revision <= state.base.revision) return state;
        return { ...initialDocState(event.doc, state.generation + 1), refreshedRevision: event.doc.revision };
      case "rebase": {
        const draft = state.pending.reduce((doc, item) => apply(doc, item.action), event.latest);
        const changed = draft !== event.latest;
        return {
          ...state,
          base: event.latest,
          draft,
          status: changed ? "dirty" : "saved",
          error: null,
          storedRevision: null,
          // Nothing left to save when no action applies any more
          pending: changed ? state.pending : [],
          savedSeq: changed ? state.savedSeq : state.editSeq,
          generation: state.generation + 1,
        };
      }
    }
  };
}
