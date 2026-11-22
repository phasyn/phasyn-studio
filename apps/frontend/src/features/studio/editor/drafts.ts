import { createContext, use, useImperativeHandle, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";

export interface EditorDraftHandle { commit: () => boolean; focus: () => void }

/** Only document-property drafts opt in. Command forms keep their explicit Apply action. */
export function createEditorDrafts() {
  const entries = new Set<RefObject<EditorDraftHandle | null>>();
  return {
    register(entry: RefObject<EditorDraftHandle | null>) {
      entries.add(entry);
      return () => { entries.delete(entry); };
    },
    commitAll(): boolean {
      for (const entry of [...entries]) {
        if (!entries.has(entry)) continue;
        const result = { accepted: true };
        // Each commit renders before the next draft reads its latest document props.
        // Autosave's layout snapshot then observes the same committed document.
        // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- Each pending edit must commit its DOM and document snapshot before the next draft reads it.
        flushSync(() => { result.accepted = entry.current?.commit() ?? true; });
        if (!result.accepted) { entry.current?.focus(); return false; }
      }
      return true;
    },
  };
}

export const EditorDraftContext = createContext<ReturnType<typeof createEditorDrafts> | null>(null);

export function useEditorDraftHandle(entry: RefObject<EditorDraftHandle | null>): void {
  const registry = use(EditorDraftContext);
  useLayoutEffect(() => registry?.register(entry), [entry, registry]);
}

export function useEditorDraft(handle: EditorDraftHandle): void {
  const entryRef = useRef<EditorDraftHandle | null>(null);
  useImperativeHandle(entryRef, () => handle);
  useEditorDraftHandle(entryRef);
}
