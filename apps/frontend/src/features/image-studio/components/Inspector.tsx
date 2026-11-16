// 右側屬性面板：選取圖片的設定分成「基本／採樣／圖片」三個分頁（44 px 分頁列）。生成的主動作在工具列（「生成圖片」，
// 狀態與不能生成的原因也在那裡）；這裡的 Ctrl+Enter 呼叫同一個生成。專案沒有圖片時工作區不顯示這個面板。
import { Gauge, ImagePlus, SlidersHorizontal } from "lucide-react";
import type { KeyboardEvent } from "react";
import { PANEL_RAISED } from "@/components/ui/look";
import { usePanelEnter } from "@/components/ui/motion";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { PanelCollapseButton } from "@/features/studio-shell";
import { useImageStudio } from "../imageStudioContext";
import { imageShots } from "../model/shots";
import type { StudioImageShot } from "../types";
import { BasicTab } from "./BasicTab";
import { ImageTab } from "./ImageTab";
import { PANEL_NAMES } from "./panels";
import { SamplingTab } from "./SamplingTab";
import { t } from "@/i18n";

const TAB_IDS = ["basic", "sampling", "image"] as const;
type InspectorTab = (typeof TAB_IDS)[number];

function ShotInspector({ shot, tab }: { shot: StudioImageShot; tab: InspectorTab }) {
  const { generate } = useImageStudio();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void generate(shot.image_shot_id);
    }
  };
  // 換圖片時整個屬性內容重新掛載（key＝圖片）：短淡入
  return (
    <div role="tabpanel" id={`image-inspector-panel-${tab}`} aria-labelledby={`image-inspector-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto animate-fade-in" onKeyDown={onKeyDown}>
      {tab === "basic" ? <BasicTab shot={shot} /> : tab === "sampling" ? <SamplingTab shot={shot} /> : <ImageTab shot={shot} />}
    </div>
  );
}

export function Inspector({ onCollapse }: { onCollapse?: () => void }) {
  const { project, selectedShotId } = useImageStudio();
  const [tab, setTab] = usePersistentChoice<InspectorTab>("imageStudio.inspector.tab", "basic", TAB_IDS);
  const shot = imageShots(project).find((item) => item.image_shot_id === selectedShotId) ?? null;
  // 從窄軌展開、或第一張圖片出現時，從右緣滑入
  const enter = usePanelEnter<HTMLElement>(PANEL_NAMES.inspector, "right");
  return (
    <section ref={enter} aria-label={t("圖片設定")} className={PANEL_RAISED}>
      <PanelTabs
        variant="studio"
        idPrefix="image-inspector"
        label={t("圖片設定")}
        value={tab}
        onChange={(next) => setTab((TAB_IDS as readonly string[]).includes(next) ? (next as InspectorTab) : "basic")}
        tabs={[
          { id: "basic", label: t("基本"), icon: SlidersHorizontal },
          { id: "sampling", label: t("採樣"), icon: Gauge },
          { id: "image", label: t("圖片"), icon: ImagePlus, count: shot && shot.mode === "i2i" ? shot.references.length : undefined },
        ]}
        actions={onCollapse ? <PanelCollapseButton side="right" label={PANEL_NAMES.inspector} onCollapse={onCollapse} /> : undefined}
      />
      {shot ? <ShotInspector key={shot.image_shot_id} shot={shot} tab={tab} /> : null}
    </section>
  );
}
