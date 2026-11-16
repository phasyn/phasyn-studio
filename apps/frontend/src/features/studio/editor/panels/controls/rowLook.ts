// Class recipes the rows of the property panels share (written out in full: Tailwind only scans literals).

/** The slot at the start of a row of Effect Controls: the stopwatch of an animatable property, empty otherwise. */
export const ROW_LEAD = "flex size-7 shrink-0 items-center justify-center";

/**
 * A row's label. It takes the width the panel gives it (--ec-label), so the controls of every row start on one line.
 * A row wraps by what its items need at least, so the label asks for little and grows to that width first (its grow
 * factor outweighs every other item's): on a panel dragged narrow it gives way before the row wraps. It truncates,
 * with the full text in its tooltip.
 */
export const ROW_LABEL = "max-w-[var(--ec-label,5rem)] min-w-10 shrink grow-[999] basis-10 truncate text-data text-fg-secondary";

/** A control that cannot be used right now: it stays focusable and says why in its tooltip. */
export const UNAVAILABLE = "cursor-not-allowed text-fg-disabled hover:bg-transparent hover:text-fg-disabled";
