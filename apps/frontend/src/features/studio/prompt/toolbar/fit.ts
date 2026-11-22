// How the prompt toolbar makes room when it is narrower than its tools (measured by useFitLevel, so it holds for any
// language). The toolbar is always ONE row (a second row would
// push the prompt down). It makes room in this order: the labelled buttons lose their
// icons, the padding tightens, 逐鏡描述 moves into the ⋯ menu, 固定 Prompt and then @ 參考 move into the ⋯ menu, and
// last 展開 keeps only its icon. A tool in the menu keeps its full words there, and every hidden word stays in the
// accessible name and the tooltip. 範本 always keeps its words.
// The prompt's status row under the editor (建議 n, the shot's plugin check; PromptStatusRow.tsx) has one level of its
// own: narrower than its badges, they keep only their icon, count and state. Badges read either from ToolbarFitContext.
import { createContext, use } from "react";

export const TOOLBAR_FIT_LEVELS = 6;

export interface ToolbarFit {
  /** Level 0: the labelled buttons (範本, 固定 Prompt, 逐鏡描述, 展開) show their icons. */
  icons: boolean;
  /** From level 2: tighter padding. */
  tight: boolean;
  /** From level 3: 逐鏡描述 is an item of the ⋯ menu. */
  shotsInMenu: boolean;
  /** From level 4: 固定 Prompt is an item of the ⋯ menu. */
  snippetsInMenu: boolean;
  /** From level 5: @ 參考 is an item of the ⋯ menu. */
  mentionInMenu: boolean;
  /** From level 6: 展開 shows only its icon. */
  expandIconOnly: boolean;
  /** The advisor badge shows 建議 (else the lightbulb and the count). */
  advisorLabel: boolean;
  /** Status badges show their words (else the icon, the count and the state). */
  statusLabel: boolean;
}

export function toolbarFit(level: number): ToolbarFit {
  return {
    icons: level < 1,
    tight: level >= 2,
    shotsInMenu: level >= 3,
    snippetsInMenu: level >= 4,
    mentionInMenu: level >= 5,
    expandIconOnly: level >= 6,
    advisorLabel: true,
    statusLabel: true,
  };
}

export const STATUS_FIT_LEVELS = 1;

/** The status row's fit: level 1 = the badges keep only icon, count and state. */
export function statusFit(level: number): ToolbarFit {
  return { ...toolbarFit(0), tight: level >= 1, advisorLabel: level < 1, statusLabel: level < 1 };
}

export const ToolbarFitContext = createContext<ToolbarFit>(toolbarFit(0));

export function useToolbarFit(): ToolbarFit {
  return use(ToolbarFitContext);
}

/** The shared look of a toolbar tool: 30 px, quiet, the open state of a popover in the brand selection fill. */
export const TOOL =
  "min-h-[30px] gap-1.5 [&_svg]:size-3.5 aria-expanded:bg-brand-gradient-soft aria-expanded:text-fg aria-expanded:ring-1 aria-expanded:ring-brand-blue/50 aria-expanded:ring-inset";

/** Horizontal padding of a tool at this level. */
export function toolPadding(fit: ToolbarFit): string {
  return fit.tight ? "px-1.5" : "px-2";
}
