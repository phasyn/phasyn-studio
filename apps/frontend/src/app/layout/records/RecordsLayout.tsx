import { History } from "lucide-react";
import { useLocation } from "react-router";
import { componentEntries, useCatalog } from "@/api/catalog";
import { useRunList } from "@/api/runs";
import { AreaExplorer, AreaLayout, AreaRail } from "@/app/layout/AreaLayout";
import { useCompareSelection } from "@/features/recordings";
import { buildRecordsTree, RECORDS_DEFAULT_EXPANDED, RECORDS_SECTIONS, recordsSelection } from "./recordsTree";
import { t } from "@/i18n";

/** 「紀錄」左欄：執行紀錄（近期 run）、效能紀錄、比較、追蹤設定；資料沿用 app bar 與各頁的快取。 */
function RecordsExplorer({ onCollapse }: { onCollapse: () => void }) {
  const location = useLocation();
  const runs = useRunList();
  const catalog = useCatalog();
  const compare = useCompareSelection();
  const firstPage = runs.data?.pages[0];
  const entries = catalog.data ? componentEntries(catalog.data) : undefined;
  const items = buildRecordsTree({
    runs: firstPage?.items,
    moreRuns: Boolean(firstPage?.next_cursor),
    compareCount: compare.ids.length,
    componentCount: entries?.length,
    degradedCount: entries?.filter((entry) => entry.descriptor.recorder_state === "degraded").length ?? 0,
  });
  return (
    <AreaExplorer
      title={t("紀錄")}
      label={t("紀錄導覽")}
      icon={<History aria-hidden />}
      items={items}
      candidates={recordsSelection(location.pathname)}
      storageKey="records.tree"
      defaultExpanded={RECORDS_DEFAULT_EXPANDED}
      searchPlaceholder={t("搜尋紀錄頁、run…")}
      onCollapse={onCollapse}
      footer={runs.isError && !firstPage ? t("無法讀取 run 列表：執行紀錄頁可重試") : null}
    />
  );
}

/** 紀錄工作區：/records/runs、/records/recordings、/records/comparisons、/records/tracking。 */
export function RecordsLayout() {
  return (
    <AreaLayout
      area="records"
      explorer={(collapse) => <RecordsExplorer onCollapse={collapse} />}
      rail={(expand) => <AreaRail label={t("紀錄導覽")} title={t("紀錄")} sections={RECORDS_SECTIONS} onExpand={expand} />}
    />
  );
}
