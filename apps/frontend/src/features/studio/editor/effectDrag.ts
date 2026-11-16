// What the Effects browser puts on a drag so the timeline can apply it: the id of the dragged effect, preset or
// transition. Only this module knows the transfer format. A browser hides the payload until the drop, so the drag that
// started in this page is also kept here: the timeline shows where it would land while it is still over the tracks.
export const EFFECT_DRAG_TYPE = "application/x-phasyn-studio-effect";

export interface EffectDrag {
  /** The Effects browser item (panels/effects/catalog.ts). */
  itemId: string;
}

let active: EffectDrag | null = null;

/** Marks a drag as an effect drag (call in onDragStart, and endEffectDrag in onDragEnd). */
export function writeEffectDrag(transfer: DataTransfer, drag: EffectDrag): void {
  transfer.setData(EFFECT_DRAG_TYPE, JSON.stringify(drag));
  transfer.effectAllowed = "copy";
  active = drag;
}

/** The drag is over, dropped or not (call in onDragEnd). */
export function endEffectDrag(): void {
  active = null;
}

/** The effect drag that started in this page and is still under way; null for none (or one from another window). */
export function activeEffectDrag(): EffectDrag | null {
  return active;
}

/** Whether a drag over a target carries an effect (the payload itself is readable only on drop). */
export function isEffectDrag(transfer: DataTransfer | null): boolean {
  return transfer?.types.includes(EFFECT_DRAG_TYPE) ?? false;
}

/** The dragged effect of a drop; null when the drop carries none or its payload is not ours. */
export function readEffectDrag(transfer: DataTransfer | null): EffectDrag | null {
  const raw = transfer?.getData(EFFECT_DRAG_TYPE);
  if (!raw || raw.length > 200) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { itemId } = value as Record<string, unknown>;
    return typeof itemId === "string" && itemId !== "" && itemId.length <= 120 ? { itemId } : null;
  } catch {
    return null;
  }
}
