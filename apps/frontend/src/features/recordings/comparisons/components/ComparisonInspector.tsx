// 比較頁的檢視器：比較對象（每筆一個屬性區段：元件、provider、Node、operation、時間、紀錄連結；設為基準／移除），
// 從最近紀錄挑選，底部固定「以 recording_id 加入」。清單只存在 URL 的 ?ids=（2–8 筆，第 1 筆是基準）。
import { ArrowUpToLine, ClipboardCopy, ExternalLink, GitCompareArrows, ListPlus, X } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { nodeLabel, useCatalog } from "@/api/catalog";
import { EmptyState } from "@/components/common/EmptyState";
import { IdText, TimeText } from "@/components/common/values";
import { Button } from "@/components/ui/button";
import { useFlipList } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { StatusChip } from "@/components/workbench/StatusChip";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { OperationBadge, RecordingStateBadge, SyntheticBadge } from "../../components/Badges";
import { MAX_COMPARE, useCompareSelection } from "../../model/compareStore";
import { describeError } from "../../model/errors";
import { componentsHref, recordingHref } from "../model/links";
import type { ColumnState } from "./ColumnHead";
import { AddRecordingForm, RecentRecordingPicker } from "./RecordingPicker";
import { runPath } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

type TabId = "list" | "browse";

const linkButton = cn(buttonVariants({ variant: "quiet", size: "sm" }), "pressable no-underline pointer-coarse:min-h-11");

function RecordingFacts({
  column,
  index,
  nodeName,
  onMakeBase,
  onRemove,
}: {
  column: ColumnState;
  index: number;
  nodeName: (nodeId: string) => string;
  onMakeBase: () => void;
  onRemove: () => void;
}) {
  const context = column.data?.context;
  const summary = column.data?.summary;
  const kind = providerKind(context?.provider_id);
  const name = context?.component_id ?? column.id.slice(0, 8);
  const node = context ? nodeName(context.node_id) : null;
  return (
    <PropertySection
      title={
        <>
          <span className="machine text-fg-secondary">#{index + 1}</span>{" "}
          {index === 0 ? (
            <span className="rounded-full border border-brand-blue/40 bg-brand-soft px-1.5 text-[11px] leading-4 font-semibold text-action-fg">{t("基準")}</span>
          ) : null}{" "}
          <span className="machine">{name}</span>
        </>
      }
      icon={<kind.icon aria-hidden className={TEXT_TONE[kind.tone]} />}
      // 基準（第 1 筆）與比較表的基準欄用同一個淡品牌底色
      className={index === 0 ? "bg-brand-soft/35" : undefined}
      actions={
        <>
          {index > 0 ? <ToolButton label={t("設為基準：#{index} {name}", { index: index + 1, name })} icon={<ArrowUpToLine aria-hidden />} onClick={onMakeBase} /> : null}
          <ToolButton label={t("從比較移除 #{index} {name}", { index: index + 1, name })} icon={<X aria-hidden />} onClick={onRemove} />
        </>
      }
    >
      <div className="grid gap-2">
        {context && summary ? (
          <PropertyGrid>
            <PropertyRow label={t("元件")} mono>
              {context.component_id}
            </PropertyRow>
            <PropertyRow label="provider" hint={kind.label}>
              <code className="machine">{context.provider_id}</code>
            </PropertyRow>
            <PropertyRow label="Node" hint={node !== context.node_id ? <code className="machine">{context.node_id}</code> : undefined}>
              {node}
            </PropertyRow>
            <PropertyRow label="operation">
              <span>
                <OperationBadge operation={context.operation} />
              </span>
            </PropertyRow>
            <PropertyRow label={t("狀態")}>
              <span className="flex flex-wrap items-center gap-1">
                <RecordingStateBadge state={summary.state} />
                {context.synthetic ? <SyntheticBadge /> : null}
              </span>
            </PropertyRow>
            <PropertyRow label={t("建立時間")}>
              <TimeText iso={context.created_at} />
            </PropertyRow>
            <PropertyRow label="recorder" mono>
              {context.recording.mode}
            </PropertyRow>
            <PropertyRow label="run">
              {context.run_id ? (
                <Link to={runPath(context.run_id)} className="machine text-data">
                  {context.run_id.slice(0, 8)}
                </Link>
              ) : (
                <span className="text-fg-tertiary">{t("—（不屬於 run）")}</span>
              )}
            </PropertyRow>
            <PropertyRow label="recording_id">
              <IdText value={column.id} />
            </PropertyRow>
          </PropertyGrid>
        ) : column.error ? (
          <p className="text-data text-danger">
            {t("讀取失敗：{headline}", { headline: describeError(column.error).headline })}
            <span className="mt-1 block">
              <IdText value={column.id} />
            </span>
          </p>
        ) : (
          <p role="status" className="text-data text-fg-tertiary">
            {t("讀取中…")} <IdText value={column.id} copy={false} />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Link to={recordingHref(column.id)} className={linkButton}>
            <ExternalLink aria-hidden />
            {t("開啟紀錄")}
          </Link>
          {context ? (
            <Link to={componentsHref(context.node_id, context.component_id)} className={linkButton} title={t("前往元件頁並選取此 instance；只開啟頁面，不重播指令、不自動套用或執行")}>
              <ClipboardCopy aria-hidden />
              {t("從此 recording 複製設定")}
            </Link>
          ) : null}
        </div>
      </div>
    </PropertySection>
  );
}

export function ComparisonInspector({ columns, onChange }: { columns: readonly ColumnState[]; onChange: (ids: string[]) => void }) {
  const ids = columns.map((column) => column.id);
  const full = ids.length >= MAX_COMPARE;
  const catalog = useCatalog();
  const compare = useCompareSelection();
  const storeDiffers = compare.ids.length > 0 && compare.ids.join(",") !== ids.join(",");
  const [tab, setTab] = useState<TabId>(() => (columns.length === 0 ? "browse" : "list"));
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const listHeadingRef = useRef<HTMLParagraphElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 設為基準／移除後，其他筆從舊位置平滑移到新位置（只用 transform）
  useFlipList(listRef, ids.join(","));

  /** 設為基準／移除會讓被按的按鈕消失：焦點交回清單標題，而不是掉到頁面最上方。 */
  const reorder = (next: string[]) => {
    onChange(next);
    listHeadingRef.current?.focus();
  };
  const add = (id: string) => {
    if (ids.includes(id) || full) return;
    onChange([...ids, id]);
  };

  const tabs = [
    { id: "list", label: t("比較對象"), count: ids.length },
    { id: "browse", label: t("從最近紀錄挑選") },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader
        icon={GitCompareArrows}
        tone="neutral"
        title={t("比較對象")}
        status={ids.length < 2 ? <StatusChip tone="warning" label={t("不足 2 筆")} /> : <StatusChip tone="neutral" label={t("{idsCount}／{maxCompare} 筆", { idsCount: ids.length, maxCompare: MAX_COMPARE })} />}
        description={t("依序比較，第 1 筆是設定差異的基準；清單只存在網址（?ids=），可直接分享。")}
        actions={
          storeDiffers ? (
            <Button size="sm" icon={<ListPlus aria-hidden />} onClick={() => onChange(compare.ids)} className="pointer-coarse:min-h-11">
              {t("改用紀錄頁的比較清單（{idsCount} 筆）", { idsCount: compare.ids.length })}
            </Button>
          ) : null
        }
      />
      <PanelTabs tabs={tabs} value={tab} onChange={(id) => setTab(id as TabId)} idPrefix="comparison-inspector" label={t("比較對象分頁")} variant="underline" />
      <DockBody role="tabpanel" id={`comparison-inspector-panel-${tab}`} aria-labelledby={`comparison-inspector-tab-${tab}`}>
        {tab === "list" ? (
          <div ref={listRef} className="grid content-start">
            <p
              ref={listHeadingRef}
              tabIndex={-1}
              className="border-b border-line-subtle px-3 py-2 text-caption text-fg-tertiary outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <T source={"比較對象 <0>{idsCount}/{maxCompare}</0>：設為基準會把該筆移到第 1 欄。"} values={{ idsCount: ids.length, maxCompare: MAX_COMPARE }} slots={[<span className="machine" />]} />
            </p>
            {columns.length === 0 ? (
              <EmptyState size="compact" mark title={t("尚未選擇 recording")} description={t("從「從最近紀錄挑選」或下方以 recording_id 加入。")} />
            ) : (
              columns.map((column, index) => (
                <RecordingFacts
                  key={column.id}
                  column={column}
                  index={index}
                  nodeName={(nodeId) => nodeLabel(catalog.data, nodeId)}
                  onMakeBase={() => reorder([column.id, ...ids.filter((id) => id !== column.id)])}
                  onRemove={() => reorder(ids.filter((id) => id !== column.id))}
                />
              ))
            )}
          </div>
        ) : (
          <RecentRecordingPicker ids={ids} onAdd={add} draft={draft} onDraftChange={setDraft} filter={filter} onFilterChange={setFilter} />
        )}
      </DockBody>
      <InspectorFooter>
        <AddRecordingForm ids={ids} onAdd={add} />
      </InspectorFooter>
    </div>
  );
}
