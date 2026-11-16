// The shot list's selection (model/shotSelection.ts) tied to the Studio: the list's current shot is the Studio's selected
// shot, the one the inspector and the monitor show. A current shot the list chooses is opened in the monitor at once;
// the Studio's URL catches up a moment later, and those echoes of the list's own requests are not followed (moving fast
// with the keyboard would otherwise jump back), nor is the Studio's stand-in while a deleted current shot is replaced by
// the one the list asked for. A current shot chosen elsewhere (a timeline clip, a link, a shot added, duplicated or
// deleted) is followed, keeping a selection that holds it.
import { useState } from "react";
import { useEditor } from "../../editor/editorContext";
import { useShotActions } from "../../hooks/useShotActions";
import { followCurrent, selectCurrent, visibleSelection, type ShotSelection } from "../../model/shotSelection";

/** Requests remembered while they reach the Studio. */
const MAX_ASKED = 16;

export interface ShotSelectionState {
  /** The selection of the shots listed now. */
  selection: ShotSelection;
  /** Applies a new selection; open = show its current shot in the monitor even when it already is the current one. */
  apply: (next: ShotSelection, options?: { open?: boolean }) => void;
}

export function useShotSelection(order: readonly string[]): ShotSelectionState {
  const { selectedShotId } = useEditor();
  const actions = useShotActions();
  const [stored, setStored] = useState(() => selectCurrent(selectedShotId));
  const [seen, setSeen] = useState(selectedShotId);
  /** Current shots this list asked the Studio for that have not all arrived yet (oldest first). */
  const [asked, setAsked] = useState<readonly string[]>([]);
  let current = stored;
  if (seen !== selectedShotId) {
    setSeen(selectedShotId);
    const earlierEcho = selectedShotId !== null && asked.includes(selectedShotId) && selectedShotId !== asked.at(-1);
    // The previous current shot was deleted: until the shot this list asked for arrives, the Studio shows a stand-in
    const standIn = asked.length > 0 && seen !== null && !order.includes(seen) && (selectedShotId === null || !asked.includes(selectedShotId));
    if (!earlierEcho && !standIn) {
      if (asked.length > 0) setAsked([]);
      current = followCurrent(stored, selectedShotId);
      if (current !== stored) setStored(current);
    }
  }
  const selection = visibleSelection(current, order);
  const apply = (next: ShotSelection, options: { open?: boolean } = {}) => {
    setStored(next);
    const focus = next.focus;
    if (focus === null || (options.open !== true && focus === selection.focus)) return;
    if (focus !== selectedShotId) setAsked((list) => [...list.slice(1 - MAX_ASKED), focus]);
    actions.openInSource(focus);
  };
  return { selection, apply };
}
