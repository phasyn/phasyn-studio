import { isListed } from "@/lib/json";
// Video Studio's engine sheet (渲染引擎): engine configuration only, in three tabs on a 44 px strip — 路線 (which saved
// component combination renders the selected shot; choosing a row pins it; while the shot list has a multi-selection
// the tab acts on the selected shots, as the selection bar's 路線 does), 畫質 (DiT steps and shifts, the project's frame
// format) and 元件 (the components of a route, started and stopped here). What people change for every render — 方式,
// 時長, Seed, 數量 — is in the generation row under the prompt. A panel can open the sheet on a tab and route
// (generation/engineView.ts); otherwise it shows the tab chosen last.
import { Cpu, MonitorCog, Route } from "lucide-react";
import { useEffect, useMemo } from "react";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { EngineSheet, useEngineControl, useStudioShell } from "@/features/studio-shell";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { unusableSlots } from "../../model/generationMode";
import { routeContinuity } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { useShotListSelection } from "../bin/shotListSelection";
import { EngineComponents } from "../generation/EngineComponents";
import { clearEngineView, ENGINE_TABS, setEngineView, useEngineView, type EngineTab } from "../generation/engineView";
import { RouteList } from "../generation/RouteList";
import { QualitySettings } from "../ShotSettings";
import { useCurrentRoute } from "./currentRoute";
import { t } from "@/i18n";

export function VideoEngineSheet() {
  const { project, engine, catalog, notify } = useStudio();
  const { engineOpen } = useStudioShell();
  const { route, routeId, shot } = useCurrentRoute();
  const control = useEngineControl(notify);
  const view = useEngineView();
  const [storedTab, setStoredTab] = usePersistentChoice<EngineTab>("studio.engine.tab", "routes", ENGINE_TABS);
  const tab = view?.tab ?? storedTab;
  // The shot list's multi-selection, as the shots are now (one deleted meanwhile drops out; fewer than two is none)
  const selectedIds = useShotListSelection();
  const selection = useMemo(() => {
    if (selectedIds === null) return null;
    const byId = new Map(project.shots.map((item) => [item.shot_id, item]));
    const shots = selectedIds.flatMap((id) => byId.get(id) ?? []);
    return shots.length > 1 ? shots : null;
  }, [project.shots, selectedIds]);

  // A requested view lasts while the sheet is open
  useEffect(() => {
    if (!engineOpen) clearEngineView();
  }, [engineOpen]);

  const choose = (next: string) => {
    if (!isListed(next, ENGINE_TABS)) return;
    setStoredTab(next);
    clearEngineView();
  };
  // The control that asked for the view leaves with its tab panel: focus goes to the 元件 tab instead of the page
  const showComponents = (viewed: string | null) => {
    setEngineView({ tab: "components", routeId: viewed });
    window.requestAnimationFrame(() => document.getElementById("studio-engine-tab-components")?.focus({ preventScroll: true }));
  };
  const owner = shot ? t("鏡頭「{value}」", { value: shot.title || t("未命名鏡頭") }) : t("專案預設（沒有選取鏡頭）");
  const description =
    tab === "routes"
      ? shot && selection
        ? t("選取的鏡頭用哪一條路線（元件組合）渲染。選一列＝這些鏡頭都改用它，方式不能用它的鏡頭維持原本的路線；方式在屬性面板的生成列切換。")
        : t("{owner}用哪一條路線（元件組合）渲染。選一列＝這個鏡頭固定用它；方式在屬性面板的生成列切換。", { owner })
      : tab === "quality"
        ? t("{owner}的畫質設定：DiT 步數與 shift；畫面格式套用到整個專案。", { owner })
        : t("{owner}使用的路線需要的元件。GPU 元件啟動會把模型載入顯示卡與主記憶體，用完可以停止；標「常駐」的元件是刻意一直開著的，停止前會先確認。", { owner });
  const noShot = <p className="text-caption text-fg-tertiary">{t("先在左側選一個鏡頭，再設定它的路線與畫質。")}</p>;
  // The 元件 tab's count: components the route in use is missing (its own, and the frame extractor of a first-frame route)
  const frame = route?.capability === "fl2va" ? routeContinuity(route, catalog).frame : null;
  const missing = route ? unusableSlots(route, frame ? [frame] : []).length : 0;
  return (
    <EngineSheet
      title={t("渲染引擎")}
      wide
      description={description}
      loadFailed={engine.status === "error"}
      toolbar={
        <PanelTabs
          variant="underline"
          idPrefix="studio-engine"
          label={t("渲染引擎分類")}
          value={tab}
          onChange={choose}
          tabs={[
            { id: "routes", label: t("路線"), icon: Route },
            { id: "quality", label: t("畫質"), icon: MonitorCog },
            { id: "components", label: t("元件"), icon: Cpu, ...(missing > 0 ? { count: missing } : {}), countTone: "warning" },
          ]}
          className="px-2"
        />
      }
    >
      <div role="tabpanel" id={`studio-engine-panel-${tab}`} aria-labelledby={`studio-engine-tab-${tab}`} className="grid min-w-0 content-start gap-3">
        {tab === "routes" ? shot ? <RouteList key={shot.shot_id} shot={shot} selection={selection} onShowComponents={showComponents} /> : noShot : null}
        {tab === "quality" ? shot ? <QualitySettings key={shot.shot_id} shot={shot} /> : noShot : null}
        {tab === "components" ? (
          <EngineComponents shotRoute={route} shotRouteId={routeId} viewedRouteId={view?.tab === "components" ? view.routeId : null} control={control} onBackToShot={() => { showComponents(null); }} />
        ) : null}
      </div>
      {control.dialogs}
    </EngineSheet>
  );
}
