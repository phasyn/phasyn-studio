// From the Render workspace to a shot in the Shots workspace (「前往修正」, 「比較」): the shot is selected the way the
// shot list selects it (its timeline clip follows) and the monitor shows the given take, or wipes two of them (A/B).
// Links stay links (middle click, keyboard); `prepare` runs in their onClick, before the navigation.
import { useStudio } from "../../studioContext";
import { projectHref } from "../../workspaces";

/** What the Shots monitor shows: `source` = A, `compare` = B (null = no comparison). */
export interface ShotView {
  source: string;
  compare: string | null;
}

export interface ShotsLink {
  href: (shotId: string) => string;
  prepare: (shotId: string, view?: ShotView) => void;
}

export function useShotsLink(): ShotsLink {
  const { project, selectShot, setSourceTakeId, setCompareTakeId, setMonitorMode } = useStudio();
  return {
    href: (shotId) => `${projectHref("generate", project.project_id)}&shot=${encodeURIComponent(shotId)}`,
    prepare: (shotId, view) => {
      // Selecting clears the monitor's takes, so the view is set after it
      selectShot(shotId);
      if (view) {
        setSourceTakeId(view.source);
        setCompareTakeId(view.compare);
      }
      setMonitorMode("source");
    },
  };
}
