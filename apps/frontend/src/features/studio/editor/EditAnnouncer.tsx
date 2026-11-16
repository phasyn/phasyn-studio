// The editor's one live region (polite): it says the name of each edit, undo and redo once, as the History panel lists
// it, so someone who cannot see the timeline hears what happened. A drag is one edit, written on release, so nothing is
// said while it is under way. Each sentence is a new node, so the same name said twice is heard twice.
import { useSyncExternalStore } from "react";
import type { createEditHistory } from "./history";

export function EditAnnouncer({ history }: { history: ReturnType<typeof createEditHistory> }) {
  const said = useSyncExternalStore(history.subscribe, history.announcement);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {said ? <span key={said.id}>{said.text}</span> : null}
    </div>
  );
}
