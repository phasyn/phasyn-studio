// The project panel of the Shots workspace (a floating panel that collapses to a rail): two tabs, 鏡頭 — the shot list in
// film order with its state, multi-selection and batch actions (bin/ShotList) — and 素材, the project's reference media
// (bin/MediaTab). Uploads belong to the panel, so switching tabs does not stop one. Expanded from its rail, the panel
// slides in from the left edge; the tab panels cross-fade.
import { Film, FolderOpen } from "lucide-react";
import { useState } from "react";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { PANEL } from "@/components/ui/look";
import { usePanelEnter } from "@/components/ui/motion";
import { PanelCollapseButton } from "@/features/studio-shell";
import { t } from "@/i18n";
import { videoLibrary } from "../references/materials";
import { useStudio } from "../studioContext";
import { MediaTab } from "./bin/MediaTab";
import { ShotList } from "./bin/ShotList";
import { useLibraryUploads } from "./bin/useLibraryUploads";

export function Bin({ onCollapse }: { onCollapse?: () => void }) {
  const { project } = useStudio();
  const [tab, setTab] = useState("shots");
  // Expanded from the rail: fades in from the left edge (the label is the one PanelCollapseButton and CollapsedRail use)
  const enter = usePanelEnter<HTMLElement>(t("專案面板"), "left");
  const uploads = useLibraryUploads();
  return (
    <section ref={enter} aria-label={t("專案", undefined, { context: "panel" })} className={PANEL}>
      <PanelTabs
        variant="studio"
        idPrefix="studio-bin"
        label={t("專案面板")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "shots", label: t("鏡頭"), icon: Film, count: project.shots.length },
          { id: "media", label: t("素材"), icon: FolderOpen, count: videoLibrary(project.library ?? []).length },
        ]}
        actions={onCollapse ? <PanelCollapseButton side="left" label={t("專案面板")} onCollapse={onCollapse} /> : undefined}
      />
      <div role="tabpanel" id={`studio-bin-panel-${tab}`} aria-labelledby={`studio-bin-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {tab === "shots" ? <ShotList /> : <MediaTab uploads={uploads} />}
      </div>
    </section>
  );
}
