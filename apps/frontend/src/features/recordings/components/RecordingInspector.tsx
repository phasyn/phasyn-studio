// 右側檢視器：開啟中的 recording 的事實（元件、provider、Node、operation、狀態、建立時間、recorder 模式、
// clock domain、紀錄標記與合成示例）、ID、匯出、加入比較、補抓 Node 歷史紀錄，以及中欄選取項目（part／類別／事件）的細節。
import { Download, FileQuestionMark, Hash, Info, MousePointerClick, X } from "lucide-react";
import { Link } from "react-router";
import { isApiError } from "@/api/http";
import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { formatTimestamp } from "@/lib/format";
import { useRecording } from "../api";
import { shortDomain } from "../model/clock";
import { selectionLabel, type Selection } from "../model/selection";
import { OperationBadge, RecordingFlags, RecordingStateBadge, RecordingStateChip, SyntheticBadge } from "./Badges";
import { CompareToggle } from "./CompareControls";
import { ExportActions } from "./ExportActions";
import { CopyButton, IdText, LoadingBlock } from "./Feedback";
import { FetchHistoryDialog } from "./FetchHistoryDialog";
import { RecordingDeleteButton } from "./RecordingDeleteDialog";
import { SelectionDetails } from "./SelectionDetails";
import { runPath } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function KeyLabel({ children }: { children: string }) {
  return <span className="machine text-caption [overflow-wrap:anywhere]">{children}</span>;
}

export function RecordingInspector({
  recordingId,
  selection,
  onSelect,
  onClearSelection,
  nodeLabel,
}: {
  recordingId: string;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onClearSelection: () => void;
  nodeLabel: (nodeId: string) => string | null;
}) {
  const query = useRecording(recordingId);

  if (!query.data) {
    if (query.isError) {
      const notFound = isApiError(query.error) && query.error.status === 404;
      return (
        <EmptyState
          size="compact"
          icon={<FileQuestionMark />}
          title={notFound ? t("找不到此 recording") : t("recording 讀取失敗")}
          description={
            notFound ? (
              <p>
                <T source={"<0>{recordingId}</0> 不在主控的紀錄索引中。已從主控刪除的紀錄可在中欄「從 Node 補抓」補回。"} values={{ recordingId }} slots={[<code key="slot-0" className="machine break-all" />]} />
              </p>
            ) : (
              <p>{t("錯誤與「重新讀取」在中欄；讀到資料後這裡會顯示事實、ID 與匯出。")}</p>
            )
          }
        />
      );
    }
    return <LoadingBlock label={t("讀取 recording…")} rows={4} className="px-3" />;
  }

  const recording = query.data;
  const { context, summary } = recording;
  const kind = providerKind(context.provider_id);
  const node = nodeLabel(context.node_id);

  return (
    // 以 recording_id 為 key 重建：換一筆時整個檢視器淡入上移（輪詢更新不重播）。
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={kind.icon}
        {...(kind.art === undefined ? {} : { art: kind.art })}
        tone={kind.tone}
        title={<span className="machine">{context.component_id || t("（未知元件）")}</span>}
        status={<RecordingStateChip state={summary.state} />}
        description={
          <span className="grid gap-1">
            <span>
              {kind.label} · <code className="machine">{context.provider_id || "—"}</code> · {node ?? t("（Node 名稱未知）")}
            </span>
            {context.synthetic ? (
              <span>
                <SyntheticBadge />
              </span>
            ) : null}
          </span>
        }
        id={context.recording_id}
        actions={
          <>
            <CompareToggle recordingId={context.recording_id} />
            <FetchHistoryDialog recording={recording} nodeLabel={node} />
            <RecordingDeleteButton recordingId={context.recording_id} runId={context.run_id} label={`${context.component_id || "?"} · ${context.operation}`} />
          </>
        }
      />
      <DockBody>
        <PropertySection
          // 每次選取新的項目都重新展開（使用者先前收合過也一樣）。
          key={selection ? selectionLabel(selection) : "none"}
          title={selection ? t("選取：{selection}", { selection: selectionLabel(selection) }) : t("選取項目")}
          icon={<MousePointerClick aria-hidden />}
          actions={selection ? <ToolButton label={t("清除選取")} icon={<X aria-hidden />} onClick={onClearSelection} /> : null}
        >
          {selection ? (
            <SelectionDetails recording={recording} selection={selection} onSelect={onSelect} />
          ) : (
            <p className="text-caption text-fg-tertiary">{t("在「部件」選一個 part、在「摘要」的搬運表選一個類別，或在「時間軸」選一個項目，細節會顯示在這裡。")}</p>
          )}
        </PropertySection>

        <PropertySection title={t("概要")} icon={<Info aria-hidden />}>
          <PropertyGrid>
            <PropertyRow label="operation">
              <span>
                <OperationBadge operation={context.operation} />
              </span>
            </PropertyRow>
            <PropertyRow label={t("狀態")}>
              <span>
                <RecordingStateBadge state={summary.state} />
              </span>
            </PropertyRow>
            <PropertyRow label="Node">
              <span className="text-fg">{node ?? t("（名稱未知）")}</span>
              <IdText value={context.node_id} />
            </PropertyRow>
            <PropertyRow label="provider" mono>
              {context.provider_id || "—"}
            </PropertyRow>
            <PropertyRow label={t("建立時間")}>
              <time dateTime={context.created_at} title={t("{created_at}（UTC）", { created_at: context.created_at })} className="machine">
                {formatTimestamp(context.created_at)}
              </time>
            </PropertyRow>
            <PropertyRow label={t("recorder 模式")} hint={context.recording.mode === "off" ? t("只有基本結果與 wall") : undefined}>
              <span>
                <Badge tone="neutral">
                  <span className="machine">{context.recording.mode}</span>
                </Badge>
              </span>
            </PropertyRow>
            <PropertyRow label="clock_domain">
              <code className="machine" title={context.clock_domain}>
                {context.clock_domain ? shortDomain(context.clock_domain) : "—"}
              </code>
            </PropertyRow>
            <PropertyRow label={t("紀錄標記")}>
              <RecordingFlags recording={recording} hideSynthetic />
            </PropertyRow>
            <PropertyRow label="synthetic">{context.synthetic ? <SyntheticBadge /> : <span className="text-fg-secondary">{t("否")}</span>}</PropertyRow>
          </PropertyGrid>
        </PropertySection>

        <PropertySection title={t("識別碼")} icon={<Hash aria-hidden />}>
          <PropertyGrid>
            <PropertyRow label={<KeyLabel>recording_id</KeyLabel>}>
              <IdText value={context.recording_id} length={13} />
            </PropertyRow>
            <PropertyRow label={<KeyLabel>run_id</KeyLabel>}>
              {(context.run_id != null && context.run_id !== "") ? (
                <span className="inline-flex items-center gap-1">
                  <Link to={runPath(context.run_id)} className="machine">
                    {context.run_id.slice(0, 8)}…
                  </Link>
                  <CopyButton text={context.run_id} label={t("複製 run_id {run_id}", { run_id: context.run_id })} />
                </span>
              ) : (
                <span className="text-fg-tertiary">{t("無（手動啟停或不屬於 run）")}</span>
              )}
            </PropertyRow>
            <PropertyRow label={<KeyLabel>call_id</KeyLabel>}>{(context.call_id != null && context.call_id !== "") ? <IdText value={context.call_id} /> : <span className="text-fg-tertiary">{t("無")}</span>}</PropertyRow>
            <PropertyRow label={<KeyLabel>process_instance_id</KeyLabel>}>
              <IdText value={context.process_instance_id} />
            </PropertyRow>
          </PropertyGrid>
        </PropertySection>

        <PropertySection title={t("匯出")} icon={<Download aria-hidden />}>
          <ExportActions recordingId={context.recording_id} traceExpected={context.recording.mode === "trace"} />
        </PropertySection>
      </DockBody>
    </div>
  );
}
