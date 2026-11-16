// How the prompt toolbar makes room when it is narrower than its tools (measured by useFitLevel, so it holds for any
// language): first the labelled buttons lose their icons and the padding tightens, then the tools wrap onto a second
// row. Words stay: a newcomer reads 固定 Prompt, 參考 and 建議, while an icon alone does not say what a tool does. Only a
// row narrower than a single tool gives up words, the least needed first, and every hidden word stays in the
// accessible name and the tooltip. 範本 and 展開 always keep their words. Status badges a caller adds to the toolbar
// (the shot's plugin check) read the level from ToolbarFitContext.
import { createContext, useContext } from "react";

export const TOOLBAR_FIT_LEVELS = 7;

export interface ToolbarFit {
  /** Level 0: the labelled buttons (範本, 固定 Prompt, 展開) show their icons. */
  icons: boolean;
  /** From level 2: tighter padding. */
  tight: boolean;
  /** From level 3: the tools wrap onto further rows. */
  wrap: boolean;
  /** Below level 4: 固定 Prompt shows its words (then only its icon). */
  snippetLabel: boolean;
  /** Below level 5: @ 參考 shows its word (then only the @). */
  mentionLabel: boolean;
  /** Below level 6: the advisor badge shows 建議 (then the lightbulb and the count). */
  advisorLabel: boolean;
  /** Below level 7: status badges show their words (then the icon, the count and the state). */
  statusLabel: boolean;
}

export function toolbarFit(level: number): ToolbarFit {
  return {
    icons: level < 1,
    tight: level >= 2,
    wrap: level >= 3,
    snippetLabel: level < 4,
    mentionLabel: level < 5,
    advisorLabel: level < 6,
    statusLabel: level < 7,
  };
}

export const ToolbarFitContext = createContext<ToolbarFit>(toolbarFit(0));

export function useToolbarFit(): ToolbarFit {
  return useContext(ToolbarFitContext);
}

/** The shared look of a toolbar tool: 28 px, quiet, the open state of a popover in the brand selection fill. */
export const TOOL =
  "min-h-7 gap-1.5 [&_svg]:size-3.5 aria-expanded:bg-brand-gradient-soft aria-expanded:text-fg aria-expanded:ring-1 aria-expanded:ring-brand-blue/50 aria-expanded:ring-inset";

/** Horizontal padding of a tool at this level (tight from level 2). */
export function toolPadding(fit: ToolbarFit): string {
  return fit.tight ? "px-1.5" : "px-2";
}
