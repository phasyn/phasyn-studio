// Dragging a shot in the shot list (HTML drag and drop): the row moves to another place in the film order.

/** The dataTransfer type; its value is the shot_id. */
export const SHOT_DRAG_TYPE = "application/x-phasyn-shot";

export function hasShotDrag(types: readonly string[]): boolean {
  return types.includes(SHOT_DRAG_TYPE);
}
