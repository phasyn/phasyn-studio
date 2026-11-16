// 底部 dock「活動」：run（建立、步驟開始／結束、結束）與近期 recording 動態，全部來自真實 API。
// 放在 BottomDock 的分頁內容區（flex 欄）：篩選列固定，表格是唯一的 scroll owner。
import { Activity, Eraser, FilterX } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { LogFilterBar } from "./LogFilterBar";
import { LogError, LogLoading, LogMessage, SourceErrorRow } from "./LogStatus";
import { LogTable } from "./LogTable";
import { useActivityFeed } from "./useActivityFeed";
import { useLogView } from "./useLogView";
import { t } from "@/i18n";

export interface ActivityLogProps {
  /** 分頁隱藏或 dock 收合時傳 true：停止輪詢（保留使用者的「即時」選擇）。 */
  paused?: boolean;
  className?: string;
  /** run 明細：預設只顯示這個 run 的活動（可切換成全部活動）。 */
  runId?: string;
}

type Scope = "run" | "all";
const SCOPE_OPTIONS: readonly { value: Scope; label: string }[] = [
  { value: "run", label: t("這個 run") },
  { value: "all", label: t("全部活動") },
];

export function ActivityLog({ paused = false, className, runId }: ActivityLogProps) {
  const [live, setLive] = useState(true);
  const [scope, setScope] = useState<Scope>("run");
  const scopedRun = runId && scope === "run" ? runId : null;
  const feed = useActivityFeed({ live: live && !paused, runId: scopedRun });
  const view = useLogView(feed.lines);
  const { runs, recordings } = feed.status;

  const noData = !runs.hasData && !recordings.hasData;
  const loading = noData && (runs.loading || recordings.loading);
  const allFailed = noData && !loading && Boolean(runs.error || recordings.error);

  let empty: ReactNode = null;
  if (view.visible.length === 0) {
    if (loading) {
      empty = <LogLoading />;
    } else if (allFailed) {
      empty = <LogError error={runs.error ?? recordings.error} title={t("無法讀取活動紀錄")} onRetry={feed.refetch} retrying={feed.fetching} />;
    } else if (feed.lines.length === 0) {
      empty = (
        <LogMessage icon={<Activity />}>
          {scopedRun ? t("這個 run 還沒有活動紀錄。") : t("尚無活動：建立 run、啟動或呼叫元件後，紀錄會出現在這裡。")}
        </LogMessage>
      );
    } else if (view.filtersActive) {
      empty = (
        <LogMessage
          icon={<FilterX />}
          action={
            <Button size="sm" variant="quiet" onClick={view.resetFilters} className="min-h-7 px-2">
              {t("清除篩選")}
            </Button>
          }
        >
          {t("沒有符合篩選條件的紀錄。")}
        </LogMessage>
      );
    } else {
      empty = (
        <LogMessage
          icon={<Eraser />}
          action={
            <Button size="sm" variant="quiet" onClick={view.restore} className="min-h-7 px-2">
              {t("還原")}
            </Button>
          }
        >
          {t("畫面已清除（伺服器資料未刪除）；新的活動會出現在這裡。")}
        </LogMessage>
      );
    }
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-1 flex-col", className)}>
      <LogFilterBar
        label={t("活動紀錄篩選")}
        filter={view.filter}
        onFilterChange={view.setFilter}
        sourceKinds={view.sourceKinds}
        live={live}
        onLiveChange={(next) => {
          setLive(next);
          // 重新開啟即時：立刻讀一次，不必等下一個輪詢週期。
          if (next) feed.refetch();
        }}
        shown={view.visible.length}
        total={view.total}
        cleared={view.cleared}
        onClear={view.clear}
        onRestore={view.restore}
        onRefresh={feed.refetch}
        refreshing={!live && feed.fetching}
        scope={runId ? { value: scope, options: SCOPE_OPTIONS, onChange: (value) => setScope(value === "all" ? "all" : "run") } : undefined}
      />
      {allFailed ? null : (
        <>
          <SourceErrorRow status={runs} onRetry={feed.refetch} retrying={runs.fetching} />
          <SourceErrorRow status={recordings} onRetry={feed.refetch} retrying={recordings.fetching} />
        </>
      )}
      <LogTable lines={view.visible} label={scopedRun ? t("這個 run 的活動紀錄") : t("活動紀錄")} wrap={view.wrap} onWrapChange={view.setWrap} empty={empty} />
    </div>
  );
}
