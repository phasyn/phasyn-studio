// Why a shot of the batch cannot be rendered. Each candidate row works it out with useRenderBlock (the render button's
// own check, so the list and the button can never disagree) and reports it here; the batch button reads the reports and
// counts only what would really be sent. A small external store: rows write in a layout effect (before paint), the
// toolbar reads it with useSyncExternalStore.
import { useLayoutEffect, useSyncExternalStore } from "react";

export interface BlockReports {
  report: (shotId: string, reason: string | null) => void;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => ReadonlyMap<string, string>;
}

export function createBlockReports(): BlockReports {
  let reasons: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<() => void>();
  return {
    report(shotId, reason) {
      if ((reasons.get(shotId) ?? null) === reason) return;
      const next = new Map(reasons);
      if (reason === null) next.delete(shotId);
      else next.set(shotId, reason);
      reasons = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => reasons,
  };
}

/** The reasons reported so far, by shot id. */
export function useBlockReasons(reports: BlockReports): ReadonlyMap<string, string> {
  return useSyncExternalStore(reports.subscribe, reports.snapshot);
}

/** Reports a row's reason while the row is a candidate of the batch; the report goes when the row stops being one. */
export function useReportBlock(reports: BlockReports, shotId: string, reason: string | null): void {
  useLayoutEffect(() => {
    reports.report(shotId, reason);
  }, [reports, shotId, reason]);
  useLayoutEffect(() => () => { reports.report(shotId, null); }, [reports, shotId]);
}
