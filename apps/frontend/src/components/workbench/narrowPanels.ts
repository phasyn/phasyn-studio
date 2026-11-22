// Workbench panel rows on a phone (below the md breakpoint): the side-by-side panels do not fit, so each open panel takes
// the full width and the row scrolls and snaps sideways inside itself; the page itself never scrolls sideways. A row sets
// its desktop template in --panel-cols and its phone template in --panel-cols-narrow (inline style); the row is positioned
// there, so absolutely placed descendants (sr-only labels) scroll with it instead of widening the page. The splitters keep
// their grid cells there but are hidden and inert, so dragging on a phone never changes the remembered desktop sizes.

import type { CSSProperties } from "react";

export const NARROW_PANEL_ROW =
  "grid-cols-(--panel-cols) max-md:relative max-md:grid-cols-(--panel-cols-narrow) max-md:snap-x max-md:snap-mandatory max-md:overflow-x-auto max-md:overscroll-x-contain max-md:*:snap-start";

export const NARROW_HIDDEN = "max-md:pointer-events-none max-md:invisible";

interface PanelColumnsStyle extends CSSProperties {
  "--panel-cols": string;
  "--panel-cols-narrow": string;
}

/** The inline style of a NARROW_PANEL_ROW: its desktop and its phone column templates. */
export function panelColumns(desktop: string, narrow: string): PanelColumnsStyle {
  return { "--panel-cols": desktop, "--panel-cols-narrow": narrow };
}
