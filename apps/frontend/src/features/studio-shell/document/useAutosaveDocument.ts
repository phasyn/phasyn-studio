// The single owner of a Studio document: local draft + autosave (debounced, optimistic revision) on top of docReducer.
// Every save is sent once; failures keep the draft and wait for the next edit or a manual retry. A successful save is
// always published to the query cache — also when it completes after unmount — so the page opened next reads the
// newest revision. Leaving the page (or switching project) sends the unsaved edits once (keepalive): when a save is
// still in flight, they go after it, on the revision it creates. The browser warns before closing with unsaved edits.
// After a revision conflict the server's newest version is read once (a read: nothing is resent) and handed to the
// reducer, which takes it as saved when it already holds every unsaved edit, e.g. another tab of the same project wrote
// back the same render results; otherwise the conflict stands and autosave pauses. refresh() loads a newer version saved
// elsewhere (another tab, an AI agent) while nothing here is unsaved; the reducer refuses it once an edit came in.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { isApiError } from "@/api/http";
import { initialDocState, type DocReducer, type DocState, type VersionedDoc } from "./docReducer";
import { t } from "@/i18n";
import { resolveConflicts, type Side } from "./threeWayMerge";

export interface AutosaveOptions<TDoc extends VersionedDoc, TAction> {
  initial: TDoc;
  /** Checks the result of a field-by-field merge before writing the combined document. */
  parseMerged: (candidate: unknown) => TDoc | Promise<TDoc>;
  /** createDocReducer(...) result; keep it module-level so its identity is stable. */
  reducer: DocReducer<TDoc, TAction>;
  save: (doc: TDoc, options: { keepalive?: boolean }) => Promise<TDoc>;
  /** The server's newest version of the same document. */
  fetchLatest: (doc: TDoc) => Promise<TDoc>;
  /** Writes a saved or reloaded version to the query cache. */
  publish: (doc: TDoc) => void;
  autosaveMs?: number;
}

export interface AutosaveDocument<TDoc, TAction> {
  state: DocState<TDoc, TAction>;
  dispatch: (action: TAction) => void;
  saveNow: () => void;
  /** Saves now and waits until the draft is saved; rejects on conflict, a failed save or after 15 s. */
  flush: () => Promise<void>;
  /** Drops the local draft and loads the server version. */
  reload: () => Promise<void>;
  /** Loads the server's version when `revision` (the server's current one) is newer and nothing here is unsaved. */
  refresh: (revision: number) => Promise<void>;
  /** Saves the local draft over the server version (explicit user choice after a conflict). */
  /**
   * Saves this tab's changes over the server's newest version, field by field (three-way merge against the version
   * this tab started from): what only the server changed is kept, what only this tab changed is written, and a field
   * both changed takes the side named in `choices` (default: the server's).
   */
  overwrite: (choices?: ReadonlyMap<string, Side>) => Promise<void>;
  /** Re-applies the unsaved actions on the server version (needs a reducer created with trackPending). */
  rebase: () => Promise<void>;
  /** Reads the server's newest version (a read: nothing changes) and pairs it with this tab's draft and unsaved actions. */
  previewConflict: () => Promise<{ base: TDoc; latest: TDoc; draft: TDoc; pending: TAction[] }>;
  /**
   * A change the server makes to the document: saves the draft, hands the saved version to `change` (which answers
   * the document's new version) and continues from that answer. Rejects when the save or the change fails, and when
   * an edit came in while the change ran (the draft is kept; its next save meets the revision conflict as usual).
   * Changes run one at a time, each on the version the previous one answered (two fix results that finish together
   * would otherwise both write on the same revision, and the second would be lost).
   */
  transact: (change: (saved: TDoc) => Promise<TDoc>) => Promise<void>;
}

type FlightOutcome<TDoc> = { kind: "saved"; doc: TDoc } | { kind: "conflict" } | { kind: "failed" };

/** The save in flight (one at a time): the edits it takes (up to `seq`) and how it ends. */
interface Flight<TDoc> {
  seq: number;
  generation: number;
  outcome: Promise<FlightOutcome<TDoc>>;
}

const isConflict = (error: unknown) => isApiError(error) && error.code === "REVISION_CONFLICT";

const FLUSH_TIMEOUT_MS = 15_000;
const FLUSH_POLL_MS = 100;
const TRANSACT_POLL_MS = 16;

export function useAutosaveDocument<TDoc extends VersionedDoc, TAction>(options: AutosaveOptions<TDoc, TAction>): AutosaveDocument<TDoc, TAction> {
  const { reducer, autosaveMs = 700 } = options;
  const [state, send] = useReducer(reducer, options.initial, initialDocState<TDoc, TAction>);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const isMounted = () => mountedRef.current;
  const ioRef = useRef(options);
  const flightRef = useRef<Flight<TDoc> | null>(null);
  /** The latest save that succeeded (it may not be in the state yet when the page leaves right after it). */
  const lastSavedRef = useRef<{ seq: number; generation: number; doc: TDoc } | null>(null);

  // Imperative save calls after a synchronous form commit must observe that commit.
  // Keep this snapshot current during commit; debounce and network effects remain passive.
  useLayoutEffect(() => {
    stateRef.current = state;
    ioRef.current = options;
  });

  const runSave = useCallback(async (doc: TDoc, seq: number) => {
    const generation = stateRef.current.generation;
    send({ type: "saveStart" });
    const request = ioRef.current.save(doc, {});
    const current: Flight<TDoc> = {
      seq,
      generation,
      outcome: request.then(
        (saved): FlightOutcome<TDoc> => ({ kind: "saved", doc: saved }),
        (error: unknown): FlightOutcome<TDoc> => (isConflict(error) ? { kind: "conflict" } : { kind: "failed" }),
      ),
    };
    flightRef.current = current;
    try {
      const saved = await request;
      lastSavedRef.current = { seq, generation, doc: saved };
      ioRef.current.publish(saved);
      if (mountedRef.current) send({ type: "saveOk", saved, seq, generation });
    } catch (error) {
      if (!isMounted()) return;
      if (isConflict(error) && isApiError(error)) {
        const stored = error.details["stored_revision"];
        // One read of the server version; when it fails the conflict is shown as before
        const latest = await ioRef.current.fetchLatest(stateRef.current.base).then(
          (doc): TDoc | undefined => doc,
          () => undefined,
        );
        if (!isMounted()) return;
        if (latest) ioRef.current.publish(latest);
        send({ type: "conflict", error, storedRevision: typeof stored === "number" ? stored : null, generation, ...(latest === undefined ? {} : { latest }) });
      } else {
        send({ type: "saveError", error, generation });
      }
    } finally {
      if (flightRef.current === current) flightRef.current = null;
    }
  }, []);

  const saveNow = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "saving" || current.status === "conflict") return;
    void runSave(current.draft, current.editSeq);
  }, [runSave]);

  useEffect(() => {
    if (state.status !== "dirty") return;
    const timer = window.setTimeout(saveNow, autosaveMs);
    return () => { window.clearTimeout(timer); };
  }, [state.status, state.editSeq, saveNow, autosaveMs]);

  const flush = useCallback(async () => {
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    let attempted = false;
    while (Date.now() < deadline) {
      const current = stateRef.current;
      if (current.status === "saved") return;
      if (current.status === "conflict") throw new Error(t("專案有版本衝突：先在上方橫幅選擇怎麼處理，再繼續"));
      if (current.status === "error" && attempted) throw new Error(t("專案保存失敗：先處理保存問題，再繼續"));
      if ((current.status === "dirty" || current.status === "error") && !attempted) {
        attempted = true;
        await runSave(current.draft, current.editSeq);
        continue;
      }
      await new Promise((resolve) => void window.setTimeout(resolve, FLUSH_POLL_MS));
    }
    throw new Error(t("等待專案保存逾時"));
  }, [runSave]);

  const reload = useCallback(async () => {
    const latest = await ioRef.current.fetchLatest(stateRef.current.base);
    if (!isMounted()) return;
    send({ type: "reset", doc: latest });
    ioRef.current.publish(latest);
  }, []);

  const refreshingRef = useRef(false);
  const refresh = useCallback(async (revision: number) => {
    const current = stateRef.current;
    if (refreshingRef.current || current.status !== "saved" || revision <= current.base.revision) return;
    refreshingRef.current = true;
    try {
      const latest = await ioRef.current.fetchLatest(current.base).then(
        (doc): TDoc | undefined => doc,
        () => undefined,
      );
      if (!latest || !mountedRef.current) return;
      send({ type: "refresh", doc: latest });
      ioRef.current.publish(latest);
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  const overwrite = useCallback(
    async (choices: ReadonlyMap<string, Side> = new Map()) => {
      const latest = await ioRef.current.fetchLatest(stateRef.current.base);
      if (!isMounted()) return;
      const current = stateRef.current;
      // Never send the whole stale draft: a change saved elsewhere meanwhile (another tab muting A1) would be lost
      const merged = await ioRef.current.parseMerged(resolveConflicts(current.base, latest, current.draft, choices));
      if (!isMounted() || stateRef.current.generation !== current.generation || stateRef.current.editSeq !== current.editSeq) return;
      await runSave({ ...merged, revision: latest.revision }, current.editSeq);
    },
    [runSave],
  );

  const rebase = useCallback(async () => {
    const latest = await ioRef.current.fetchLatest(stateRef.current.base);
    if (!isMounted()) return;
    send({ type: "rebase", latest });
    ioRef.current.publish(latest);
  }, []);

  const previewConflict = useCallback(async () => {
    const latest = await ioRef.current.fetchLatest(stateRef.current.base);
    const current = stateRef.current;
    return { base: current.base, latest, draft: current.draft, pending: current.pending.map((item) => item.action) };
  }, []);

  /** The transact running now and those queued behind it (each starts when the one before has ended, either way). */
  const transactQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** The generation the last transact's answer starts; the next transact waits until the state has reached it. */
  const transactGenerationRef = useRef(-1);

  const transact = useCallback(
    (change: (saved: TDoc) => Promise<TDoc>) => {
      const run = transactQueueRef.current.then(async () => {
        // The answer of the transact before this one is applied on the next render: start from it, not from the
        // version it replaced (that would be a revision conflict on the server)
        const deadline = Date.now() + FLUSH_TIMEOUT_MS;
        while (isMounted() && stateRef.current.generation < transactGenerationRef.current && Date.now() < deadline) {
          await new Promise((resolve) => void window.setTimeout(resolve, TRANSACT_POLL_MS));
        }
        await flush();
        const started = stateRef.current;
        const next = await change(started.base);
        ioRef.current.publish(next);
        if (!isMounted()) return;
        const current = stateRef.current;
        if (current.generation !== started.generation || current.editSeq !== started.editSeq) throw new Error(t("套用期間專案又有新的修改；請重新整理後再試一次"));
        transactGenerationRef.current = started.generation + 1;
        send({ type: "reset", doc: next });
      });
      transactQueueRef.current = run.catch(() => undefined);
      return run;
    },
    [flush],
  );

  // Unmount (switching project or Studio): send the edits no save has taken yet, once, without retrying
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = stateRef.current;
      // Only this document version counts (a reload or a merge starts a new generation)
      const inFlight = flightRef.current?.generation === current.generation ? flightRef.current : null;
      const saved = lastSavedRef.current?.generation === current.generation && lastSavedRef.current.seq > current.savedSeq ? lastSavedRef.current : null;
      // Saved up to savedSeq (or a save that just ended); the save in flight takes everything up to its seq.
      // After a conflict nothing is sent.
      if (current.status === "conflict" || current.editSeq <= Math.max(current.savedSeq, saved?.seq ?? 0, inFlight?.seq ?? 0)) return;
      const draft = current.draft;
      const sendOnce = (base: VersionedDoc) => {
        void ioRef.current
          .save({ ...draft, revision: base.revision, created_at: base.created_at, updated_at: base.updated_at }, { keepalive: true })
          .then((saved) => { ioRef.current.publish(saved); })
          .catch(() => undefined);
      };
      if (!inFlight) {
        sendOnce(saved?.doc ?? draft);
        return;
      }
      // Still saving: the newer edits go once that save ends, on the revision it creates (on the old revision they would
      // conflict). After a failed save they go on the old revision (still once); after a conflict not at all.
      void inFlight.outcome.then((outcome) => {
        if (outcome.kind === "saved") sendOnce(outcome.doc);
        else if (outcome.kind === "failed") sendOnce(draft);
      });
    };
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const status = stateRef.current.status;
      if (status === "dirty" || status === "saving" || status === "error" || status === "conflict") event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); };
  }, []);

  const dispatch = useCallback((action: TAction) => { send({ type: "edit", action }); }, []);

  return { state, dispatch, saveNow, flush, reload, refresh, overwrite, rebase, previewConflict, transact };
}
