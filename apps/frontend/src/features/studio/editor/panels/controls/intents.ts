// What a command asks of Effect Controls: bring one field forward (the clip's name for "rename", its speed for
// "speed"). The panel opens that field's group and focuses the field, once per request. A request stays in the editor
// after it was served, so which one was served last is kept per editor instance, outside the panel: a panel that is
// mounted again (another tab was shown meanwhile) does not serve an old request a second time.
import { useEffect, useSyncExternalStore, type RefObject } from "react";
import type { Editor, EditorIntent } from "../../editorContext";

export type RequestedField = NonNullable<EditorIntent["field"]>;

export interface FieldRequest {
  /** The id of the editor's request: a new id is a new request, even for the same field. */
  id: number;
  field: RequestedField;
}

/** The newest request each editor instance has had served (keyed by its draft registry, which lives as long as the editor). */
const served = new WeakMap<object, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function serve(owner: object, id: number): void {
  if ((served.get(owner) ?? 0) >= id) return;
  served.set(owner, id);
  for (const listener of listeners) listener();
}

/**
 * The field a command asks for, for the one render in which the panel brings it forward; null before and after. The
 * panel that calls this serves the request, whether or not a clip is selected at that moment.
 */
export function useFieldRequest(editor: Pick<Editor, "ui" | "drafts">): FieldRequest | null {
  const { drafts } = editor;
  const done = useSyncExternalStore(subscribe, () => served.get(drafts) ?? 0);
  const intent = editor.ui.intent;
  const request = intent && intent.panel === "controls" && intent.field && done < intent.id ? { id: intent.id, field: intent.field } : null;
  const id = request?.id ?? null;
  useEffect(() => {
    if (id !== null) serve(drafts, id);
  }, [drafts, id]);
  return request;
}

/** Focuses a field and selects its text when a request names it (`request` is the request's id; null when none names it). */
export function useFocusRequest(field: RefObject<HTMLInputElement | null>, request: number | null): void {
  useEffect(() => {
    if (request === null) return;
    field.current?.focus();
    field.current?.select();
  }, [field, request]);
}
