// The shot list's multi-selection (pure), with the asset library's rules (same shape and names as
// components/library/selection.ts): a click selects one shot, Ctrl/⌘+click adds or removes one, Shift+click selects the
// range from the anchor (with Ctrl/⌘ it is added to the selection), Ctrl/⌘+A selects every shot and Escape keeps only
// the current one. `focus` is the current shot: the one the inspector and the monitor show (the Studio's selected shot
// follows it) and the row the keyboard moves from. Because it drives the inspector, taking another shot out of the
// selection leaves it where it is; only the current shot itself can be outside the selection. The selection is what
// the batch actions change.

export interface ShotSelection {
  ids: ReadonlySet<string>;
  focus: string | null;
  anchor: string | null;
}

export const NO_SELECTION: ShotSelection = { ids: new Set(), focus: null, anchor: null };

/** A click: only this shot, which becomes the current one. */
export function selectOnly(id: string): ShotSelection {
  return { ids: new Set([id]), focus: id, anchor: id };
}

/** The selection of a list whose current shot is `id`; nothing while there is none. */
export function selectCurrent(id: string | null): ShotSelection {
  return id === null ? NO_SELECTION : selectOnly(id);
}

/**
 * Ctrl/⌘+click or Space: the shot joins the selection and becomes the current one, or leaves it. A shot taken out
 * leaves the current shot where it is (the inspector does not jump to a shot that was just deselected); only the
 * current shot itself can end up outside the selection.
 */
export function toggleSelected(selection: ShotSelection, id: string): ShotSelection {
  const ids = new Set(selection.ids);
  if (!ids.has(id)) return { ids: ids.add(id), focus: id, anchor: id };
  ids.delete(id);
  const focus = selection.focus !== null && selection.focus !== id && ids.has(selection.focus) ? selection.focus : id;
  return { ids, focus, anchor: id };
}

/** Shift: the shots from the anchor to `id` in list order (`order`); additive keeps the rest of the selection. */
export function selectRange(selection: ShotSelection, order: readonly string[], id: string, additive: boolean): ShotSelection {
  const to = order.indexOf(id);
  if (to < 0) return selection;
  const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : id;
  const from = order.indexOf(anchor);
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return { ids: new Set([...(additive ? selection.ids : []), ...range]), focus: id, anchor };
}

/** Ctrl/⌘+A: every shot; the current one stays current. */
export function selectAll(order: readonly string[], focus: string | null): ShotSelection {
  const current = focus ?? order[0] ?? null;
  return { ids: new Set(order), focus: current, anchor: current };
}

/** Escape and 清除: only the current shot stays selected. */
export function keepCurrent(selection: ShotSelection): ShotSelection {
  return selectCurrent(selection.focus);
}

/**
 * The keyboard moves to the shot at `index` (clamped to the list): it is selected alone, ends a range from the anchor
 * (extend, Shift) or only becomes the current shot while the selection stays (keep, Ctrl/⌘).
 */
export function moveTo(selection: ShotSelection, order: readonly string[], index: number, mode: "select" | "extend" | "keep"): ShotSelection {
  const id = order[Math.min(order.length - 1, Math.max(0, index))];
  if (id === undefined) return selection;
  if (mode === "extend") return selectRange(selection, order, id, false);
  if (mode === "keep") return { ...selection, focus: id };
  return selectOnly(id);
}

/** A shot becomes current while the selection stays (a menu opened on a selected row, the first shot that is blocked). */
export function focusShot(selection: ShotSelection, id: string): ShotSelection {
  return selection.ids.has(id) ? { ...selection, focus: id } : selectOnly(id);
}

/**
 * The Studio's current shot changed somewhere else (a timeline clip, a link, a shot added, duplicated or deleted): a
 * selection that holds it stays, with it as the current shot; otherwise it is selected alone.
 */
export function followCurrent(selection: ShotSelection, current: string | null): ShotSelection {
  if (current === selection.focus) return selection;
  return current !== null && selection.ids.has(current) ? { ...selection, focus: current } : selectCurrent(current);
}

/** Only the shots still listed (a shot was deleted, the project was reloaded). */
export function visibleSelection(selection: ShotSelection, order: readonly string[]): ShotSelection {
  const present = new Set(order);
  const ids = [...selection.ids].filter((id) => present.has(id));
  const focus = selection.focus !== null && present.has(selection.focus) ? selection.focus : null;
  const anchor = selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : focus;
  if (ids.length === selection.ids.size && focus === selection.focus && anchor === selection.anchor) return selection;
  return { ids: new Set(ids), focus, anchor };
}

/** The selected shots in list order. */
export function selectedInOrder(selection: ShotSelection, order: readonly string[]): string[] {
  return order.filter((id) => selection.ids.has(id));
}

/** Two or more shots are selected: the batch actions apply to them. */
export function isBatchSelection(selection: ShotSelection): boolean {
  return selection.ids.size >= 2;
}
