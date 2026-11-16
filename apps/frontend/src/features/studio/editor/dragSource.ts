// What a panel puts on a drag so the timeline can place it: the Project panel and the Source monitor drag a source
// (with the marked range when there is one); the timeline reads it on dragover and drop. Only this module knows the
// transfer format. A browser hides the payload until the drop, so the drag that started in this page is also kept
// here: the timeline previews where it would land while it is still over the tracks.
export const SOURCE_DRAG_TYPE = "application/x-phasyn-studio-source";

export interface SourceDrag {
  sourceId: string;
  /**
   * The marked source range in frames of the timeline's rate. null = the range remembered for the source in the
   * Source monitor (unmarked media: its whole length; a still: five seconds).
   */
  inFrame: number | null;
  outFrame: number | null;
}

let active: SourceDrag | null = null;

/** Marks a drag as a source drag (call in onDragStart, and endSourceDrag in onDragEnd). */
export function writeSourceDrag(transfer: DataTransfer, drag: SourceDrag): void {
  transfer.setData(SOURCE_DRAG_TYPE, JSON.stringify(drag));
  transfer.effectAllowed = "copy";
  active = drag;
}

/** The drag is over, dropped or not (call in onDragEnd). */
export function endSourceDrag(): void {
  active = null;
}

/** The source drag that started in this page and is still under way; null for none (or one from another window). */
export function activeSourceDrag(): SourceDrag | null {
  return active;
}

/** Whether a drag over a target carries a source (the payload itself is readable only on drop). */
export function isSourceDrag(transfer: DataTransfer | null): boolean {
  return transfer?.types.includes(SOURCE_DRAG_TYPE) ?? false;
}

/** The dragged source of a drop; null when the drop carries none or its payload is not ours. */
export function readSourceDrag(transfer: DataTransfer | null): SourceDrag | null {
  const raw = transfer?.getData(SOURCE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { sourceId, inFrame, outFrame } = value as Record<string, unknown>;
    if (typeof sourceId !== "string" || sourceId === "") return null;
    const frame = (item: unknown) => (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : null);
    return { sourceId, inFrame: frame(inFrame), outFrame: frame(outFrame) };
  } catch {
    return null;
  }
}
