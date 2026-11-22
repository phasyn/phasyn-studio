import { isRecord } from "@/lib/json";
// Shell state shared by both Studios: the document's save state and conflict actions, notifications and the engine
// sheet. Kept apart from each Studio's workspace context so that saving, a notice or opening the sheet re-renders only
// the shell parts, and the value is memoized so it changes only when one of these does.
import { createContext, useCallback, use, useMemo, useState } from "react";
import type { AutosaveDocument } from "./document/useAutosaveDocument";
import type { SaveStatus, VersionedDoc } from "./document/docReducer";
import { useNotices, type Notice, type NoticeInput } from "./notices/useNotices";
import { threeWayMerge, type MergeConflict, type Side } from "./document/threeWayMerge";
import { t } from "@/i18n";

/** The document fields the shell shows (project id, title, revision). */
export interface ShellDoc extends VersionedDoc {
  project_id: string;
  title: string;
}

/** What "overwrite" and "keep both" would do, read before the person confirms (nothing is written by the preview). */
export interface ConflictPreview {
  /** Fields only the server changed: kept by the field-level overwrite (a whole-document overwrite would lose them). */
  latestKept: string[];
  /** Fields only this tab changed: written by the overwrite. */
  mineApplied: string[];
  /** Fields both changed differently: the person picks a side for each. */
  conflicts: MergeConflict[];
  /** The unsaved edits "keep both" replays on the server's version, in order. */
  replayed: string[];
}

/** A short name for an unsaved edit: its type and the ids it names (no prompt or other content). */
function actionLabel(action: unknown): string {
  if (!isRecord(action)) return String(action);
  const record = action;
  const ids = Object.entries(record)
    .filter(([key, value]) => key !== "type" && /(Id|_id)$/u.test(key) && (typeof value === "string" || typeof value === "number"))
    .map(([key, value]) => `${key}=${String(value)}`);
  const type = typeof record["type"] === "string" ? record["type"] : "edit";
  return ids.length > 0 ? `${type} (${ids.join(", ")})` : type;
}

export interface StudioShellValue {
  projectId: string;
  projectTitle: string;
  revision: number;
  doc: { status: SaveStatus; error: unknown; storedRevision: number | null; pendingCount: number };
  saveNow: () => void;
  flush: () => Promise<void>;
  reload: () => Promise<void>;
  overwrite: (choices?: ReadonlyMap<string, Side>) => Promise<void>;
  previewConflict: () => Promise<ConflictPreview>;
  /** null when this Studio does not offer "keep both" (its actions are not safe to replay). */
  rebase: (() => Promise<void>) | null;
  notices: readonly Notice[];
  notify: (notice: NoticeInput) => void;
  dismiss: (id: number) => void;
  engineOpen: boolean;
  setEngineOpen: (open: boolean) => void;
}

export const StudioShellContext = createContext<StudioShellValue | null>(null);

export function useStudioShell(): StudioShellValue {
  const value = use(StudioShellContext);
  if (!value) throw new Error(t("useStudioShell 必須在 Studio 的 Provider 內使用"));
  return value;
}

/** Builds the memoized shell value of one Studio page from its document. */
export function useStudioShellValue<TDoc extends ShellDoc, TAction>(document: AutosaveDocument<TDoc, TAction>, options: { offerRebase: boolean }): StudioShellValue {
  const { notices, notify, dismiss } = useNotices();
  const [engineOpen, setEngineOpen] = useState(false);
  const { state, saveNow, flush, reload, overwrite, rebase, previewConflict: readConflict } = document;
  const draft = state.draft;
  const offerRebase = options.offerRebase;
  const previewConflict = useCallback(async (): Promise<ConflictPreview> => {
    const { base, latest, draft: mine, pending } = await readConflict();
    const merge = threeWayMerge(base, latest, mine);
    return { latestKept: merge.latestKept, mineApplied: merge.mineApplied, conflicts: merge.conflicts, replayed: pending.map(actionLabel) };
  }, [readConflict]);
  return useMemo(
    () => ({
      projectId: draft.project_id,
      projectTitle: draft.title,
      revision: draft.revision,
      doc: { status: state.status, error: state.error, storedRevision: state.storedRevision, pendingCount: state.pending.length },
      saveNow,
      flush,
      reload,
      overwrite,
      previewConflict,
      rebase: offerRebase ? rebase : null,
      notices,
      notify,
      dismiss,
      engineOpen,
      setEngineOpen,
    }),
    [draft.project_id, draft.title, draft.revision, state.status, state.error, state.storedRevision, state.pending.length, saveNow, flush, reload, overwrite, previewConflict, rebase, offerRebase, notices, notify, dismiss, engineOpen],
  );
}
