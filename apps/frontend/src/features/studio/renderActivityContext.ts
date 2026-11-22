// The render this project is waiting for (model/renderActivity.ts), worked out once by RenderActivityProvider: the
// toolbar, the status bar, the monitor and the shot list read the same figures here and send no request of their own.
import { createContext, use } from "react";
import type { RenderActivity } from "./model/renderActivity";

export const RenderActivityContext = createContext<RenderActivity | null>(null);

/** The running render this project is waiting for; null when there is none (or it belongs to another project). */
export function useRenderActivity(): RenderActivity | null {
  return use(RenderActivityContext);
}
