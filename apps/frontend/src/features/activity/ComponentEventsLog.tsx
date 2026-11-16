// 底部 dock「事件」：選取元件最新一筆 recording 的事件（runtime＝元件程序、node＝Node），每個 stream 最多最新 500 筆。
// 換元件時整個畫面狀態（篩選、清除分界、即時）重新開始，避免把 A 元件的清除分界套到 B 元件。
import { ArrowUpRight, Eraser, FilterX, ScrollText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { instanceKey } from "@/api/types";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TimeText } from "@/components/common/values";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/workbench/StatusChip";
import { cn } from "@/lib/cn";
import { shortId } from "@/lib/format";
import { LogFilterBar } from "./LogFilterBar";
import { LogError, LogLoading, LogMessage, SourceErrorRow } from "./LogStatus";
import { LogTable } from "./LogTable";
import type { StreamCoverage } from "./tail";
import { useComponentEvents, type ShownRecording } from "./useComponentEvents";
import { useLogView } from "./useLogView";
import { recordingPath } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export interface ComponentEventsLogProps {
  nodeId: string;
  componentId: string;
  /** 分頁隱藏或 dock 收合時傳 true：停止輪詢（保留使用者的「即時」選擇）。 */
  paused?: boolean;
  className?: string;
}

function coverageText(coverage: readonly StreamCoverage[]): string {
  return coverage
    .map((stream) => {
      const count = stream.partial ? t("{shown}／{value} 筆", { shown: stream.shown, value: stream.total ?? "?" }) : t("{shown} 筆", { shown: stream.shown });
      return `${stream.streamId} ${count}${stream.gap ? t("（有缺段）") : ""}`;
    })
    .join(t("・"));
}

function RecordingContextRow({ recording, coverage }: { recording: ShownRecording; coverage: readonly StreamCoverage[] }) {
  const partial = coverage.some((stream) => stream.partial);
  return (
    // One line in any width (a narrow dock would otherwise lose its table to wrapped rows): the description truncates,
    // the recording itself is one click away
    <div className="flex min-h-7 shrink-0 items-center gap-x-2 overflow-hidden border-b border-line-subtle px-3 py-0.5 text-caption text-fg-secondary">
      <span className="min-w-0 truncate">
        <T source={"顯示最近一次 <0>{operation}</0>（recording{text}<1>{recordingId}</1>・<2/>）"} values={{ operation: recording.operation, text: " ", recordingId: shortId(recording.recordingId) }} slots={[<code className="machine text-fg" />, <code className="machine text-fg" title={recording.recordingId} />, <TimeText iso={recording.createdAt} className="text-caption" />]} />
      </span>
      <StatusBadge kind="run" value={recording.state} className="shrink-0" />
      {recording.synthetic ? <StatusChip tone="neutral" label={t("合成示例")} className="shrink-0" /> : null}
      <Link to={recordingPath(recording.recordingId)} className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap">
        {t("開啟紀錄")}
        <ArrowUpRight aria-hidden className="size-3.5" />
      </Link>
      {coverage.length > 0 ? (
        <span
          className="machine ml-auto min-w-0 truncate text-fg-tertiary"
          title={`${coverageText(coverage)}\n${partial ? t("每個 stream 只載入最新 500 筆事件；完整事件請開啟紀錄") : t("已載入此 recording 的全部事件")}`}
        >
          {coverageText(coverage)}
        </span>
      ) : null}
    </div>
  );
}

function ComponentEventsView({ nodeId, componentId, paused = false, className }: ComponentEventsLogProps) {
  const [live, setLive] = useState(true);
  const events = useComponentEvents(nodeId, componentId, { live: live && !paused });
  const view = useLogView(events.lines);
  const { recording: latest, events: tail } = events.status;
  const shown = events.recording;

  let empty: ReactNode = null;
  if (view.visible.length === 0) {
    if (!nodeId || !componentId) {
      empty = <LogMessage icon={<ScrollText />}>{t("尚未選取元件：選取一個元件後，這裡會顯示它最近一次 recording 的事件。")}</LogMessage>;
    } else if (latest.loading || (shown && tail.loading)) {
      empty = <LogLoading />;
    } else if (latest.error && !latest.hasData) {
      empty = <LogError error={latest.error} title={t("無法讀取此元件的 recording")} onRetry={events.refetch} retrying={events.fetching} />;
    } else if (!shown) {
      empty = <LogMessage icon={<ScrollText />}>{t("此元件還沒有效能紀錄；啟動或呼叫後，事件會出現在這裡。")}</LogMessage>;
    } else if (tail.error && !tail.hasData) {
      empty = <LogError error={tail.error} title={t("無法讀取 recording 事件")} onRetry={events.refetch} retrying={events.fetching} />;
    } else if (events.lines.length === 0) {
      empty = (
        <LogMessage icon={<ScrollText />}>
          {shown.recorderMode === "off"
            ? t("這筆 recording 的錄製模式是 off：只有結果與摘要，沒有事件。")
            : shown.state === "running"
              ? t("這筆 recording 還沒有上傳任何事件。")
              : t("這筆 recording 沒有事件。")}
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
          {t("沒有符合篩選條件的事件。")}
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
          {t("畫面已清除（伺服器資料未刪除）；新的事件會出現在這裡。")}
        </LogMessage>
      );
    }
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-1 flex-col", className)}>
      <LogFilterBar
        label={t("元件事件篩選")}
        filter={view.filter}
        onFilterChange={view.setFilter}
        sourceKinds={view.sourceKinds}
        live={live}
        onLiveChange={(next) => {
          setLive(next);
          // 重新開啟即時：立刻讀一次，不必等下一個輪詢週期。
          if (next) events.refetch();
        }}
        shown={view.visible.length}
        total={view.total}
        cleared={view.cleared}
        onClear={view.clear}
        onRestore={view.restore}
        onRefresh={events.refetch}
        refreshing={!live && events.fetching}
      />
      {shown ? <RecordingContextRow recording={shown} coverage={events.coverage} /> : null}
      {latest.hasData ? <SourceErrorRow status={latest} onRetry={events.refetch} retrying={latest.fetching} /> : null}
      {tail.hasData ? <SourceErrorRow status={tail} onRetry={events.refetch} retrying={tail.fetching} /> : null}
      <LogTable lines={view.visible} label={t("元件 {componentId} 的事件", { componentId })} wrap={view.wrap} onWrapChange={view.setWrap} empty={empty} />
    </div>
  );
}

/** 選取元件（node_id＋component_id）最新一筆 recording 的事件；換元件時畫面狀態重新開始。 */
export function ComponentEventsLog({ nodeId, componentId, paused, className }: ComponentEventsLogProps) {
  return <ComponentEventsView key={instanceKey(nodeId, componentId)} nodeId={nodeId} componentId={componentId} paused={paused} className={className} />;
}
