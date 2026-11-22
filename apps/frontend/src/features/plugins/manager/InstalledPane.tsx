// 「已安裝」分頁：左欄＝類型與來源（附數量）、中欄＝清單、右欄＝選取的包的詳情，或進行中的安裝（預覽、失敗原因）。
// 左右欄都能收合並記住；點清單的一列時右欄自動展開。
import { Blocks, Hammer, LayoutGrid, Package, PackageSearch, ShieldCheck, SlidersHorizontal, SquareTerminal, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { countKinds, countSources, kindLabel, PLUGIN_KINDS, PLUGIN_SOURCES, sourceLabel, type PluginKind, type PluginSource } from "../model/listing";
import { PluginDetail } from "./detail/PluginDetail";
import { FilterRail, RailSection } from "./FilterRail";
import { InstallPane } from "./install/InstallPane";
import { paneColumns, type PaneLayoutProps } from "./layout";
import { useManager } from "./managerContext";
import { PluginList } from "./PluginList";

const KIND_ICONS: Record<PluginKind, LucideIcon> = { rules: ShieldCheck, generation: SlidersHorizontal, code: SquareTerminal };
const SOURCE_ICONS: Record<PluginSource, LucideIcon> = { builtin: Blocks, installed: Package, dev: Hammer };

export function InstalledPane(layout: PaneLayoutProps) {
  const { registry, installed, setInstalled, install } = useManager();
  const all = registry.list?.items ?? [];
  const kinds = countKinds(all);
  const sources = countSources(all);
  const flow = install.state.phase;
  const showInstall = installed.pane === "install" && flow !== "idle" && flow !== "done";
  const plugin = (installed.selectedId != null && installed.selectedId !== "") ? (registry.plugins.get(installed.selectedId) ?? null) : null;
  return (
    <div className={cn("grid min-h-0 flex-1", paneColumns(layout.railOpen, layout.detailOpen))}>
      {layout.railOpen ? (
        <FilterRail label={t("篩選")}>
          <RailSection
            group={{
              id: "plugin-kind",
              title: t("類型"),
              value: installed.kind,
              onChange: (kind) => { setInstalled({ kind }); },
              options: [
                { id: "all", label: t("全部"), icon: LayoutGrid, count: kinds.all },
                ...PLUGIN_KINDS.map((kind) => ({ id: kind, label: kindLabel(kind), icon: KIND_ICONS[kind], count: kinds[kind] })),
              ],
            }}
          />
          <RailSection
            group={{
              id: "plugin-source",
              title: t("來源"),
              value: installed.source,
              onChange: (source) => { setInstalled({ source }); },
              options: [
                { id: "all", label: t("全部"), icon: LayoutGrid, count: sources.all },
                ...PLUGIN_SOURCES.map((source) => ({ id: source, label: sourceLabel(source), icon: SOURCE_ICONS[source], count: sources[source] })),
              ],
            }}
          />
        </FilterRail>
      ) : null}
      <PluginList {...layout} />
      {layout.detailOpen ? (
        <aside aria-label={showInstall ? t("安裝") : t("插件詳情")} className="flex min-h-0 min-w-0 flex-col border-l border-line-subtle bg-canvas/40">
          {showInstall ? (
            <InstallPane />
          ) : plugin ? (
            <PluginDetail key={plugin.plugin_id} plugin={plugin} />
          ) : (
            <div className="grid flex-1 place-items-center">
              <EmptyState size="compact" icon={<PackageSearch />} title={t("選一個插件查看內容")} />
            </div>
          )}
        </aside>
      ) : null}
    </div>
  );
}
