import { Activity, Boxes, Braces, Gauge, Info, ListFilter, Puzzle, RotateCcw, Save, ScrollText, SlidersHorizontal, Undo2, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ActionButton } from "@/components/common/ActionButton";
import { JsonEditor } from "@/components/common/JsonEditor";
import { SchemaForm } from "@/components/common/SchemaForm";
import { SchemaDensityContext } from "@/components/common/schemaDensity";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { ToolStrip } from "@/components/workbench/ToolStrip";
import { isRecord, type JsonObject } from "@/lib/json";
import { objectProperties, requiredKeys } from "@/lib/schema";
import { sectionSchemas } from "@/features/components";
import { draftPatch, issueFieldKeys, MODE_INFO, RECORDER_MODES, RECORDER_SAVE_ID, recordingIssues, type RecorderMode, type RowDraft, type RowResult, type TrackingRow } from "./model";
import { RECORDER_FIELD_GROUPS, recorderFieldMeta } from "./recorderFields";
import { ResultChip } from "./TrackingTable";
import { componentPath, recordingsPath } from "@/app/paths";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

type Mode = "form" | "json";

const TAB_PREFIX = "recorder-inspector";

const GROUP_ICON: Record<string, LucideIcon> = { content: SlidersHorizontal, scope: ListFilter, trace: Activity, limits: Gauge };

const toolLink =
  "pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-data text-fg-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-raised hover:text-fg active:bg-sunken active:duration-0 [&_svg]:size-4 [&_svg]:shrink-0";

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function SectionTitle({ title, issues }: { title: string; issues: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{title}</span>
      {issues > 0 ? <span className="shrink-0 text-caption font-normal text-danger">{t("{issues} 個問題", { issues })}</span> : null}
    </span>
  );
}

/**
 * 依分組渲染 RecorderConfig（label｜值屬性格）；provider 宣告了自己的 recording schema 時，未分組欄位放在「其他欄位」。
 * 未實作／固定行為的欄位（capture_stderr、finite_scan、tensor_dump、trace_parts）由 recorderFieldMeta 停用並顯示原因。
 */
function RecorderSections({ row, value, onChange, disabled }: { row: TrackingRow; value: JsonObject; onChange: (next: JsonObject) => void; disabled: boolean }) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const section = sectionSchemas(row.view).recording;
  const properties = new Map(objectProperties(section.schema, section.root));
  const required = requiredKeys(section.schema, section.root);
  const issues = recordingIssues(row.view, value);
  const issueKeys = issueFieldKeys(issues);
  const meta = recorderFieldMeta(value);
  const idPrefix = `recorder-${safeKey(row.key)}`;
  const grouped = new Set(RECORDER_FIELD_GROUPS.flatMap((group) => group.keys.filter((key) => properties.has(key))));
  const leftover = [...properties.keys()].filter((key) => !grouped.has(key));
  const extras = Object.keys(value).filter((key) => value[key] !== undefined && !properties.has(key));
  const otherKeys = [...leftover, ...extras];

  const toggle = (id: string, open: boolean) =>
    setClosed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <SchemaDensityContext.Provider value="compact">
      {RECORDER_FIELD_GROUPS.map((group) => {
        const keys = group.keys.filter((key) => properties.has(key));
        if (keys.length === 0) return null;
        const Icon = GROUP_ICON[group.id] ?? SlidersHorizontal;
        const schema = {
          type: "object",
          properties: Object.fromEntries(keys.map((key) => [key, properties.get(key)])),
          required: keys.filter((key) => required.has(key)),
        };
        return (
          <PropertySection
            key={group.id}
            title={<SectionTitle title={group.title} issues={keys.filter((key) => issueKeys.has(key)).length} />}
            icon={<Icon aria-hidden />}
            open={!closed.has(group.id)}
            onOpenChange={(open) => toggle(group.id, open)}
          >
            {group.note ? <p className="pb-1 text-caption text-fg-tertiary">{group.note}</p> : null}
            <SchemaForm
              schema={schema}
              rootSchema={section.root}
              value={value}
              onChange={onChange}
              idPrefix={idPrefix}
              basePath="recording"
              issues={issues}
              disabled={disabled}
              hiddenKeys={Object.keys(value).filter((key) => !keys.includes(key))}
              fieldMeta={meta}
            />
          </PropertySection>
        );
      })}
      {otherKeys.length > 0 ? (
        <PropertySection
          title={<SectionTitle title={t("其他欄位")} issues={otherKeys.filter((key) => issueKeys.has(key)).length} />}
          icon={<Braces aria-hidden />}
          open={!closed.has("other")}
          onOpenChange={(open) => toggle("other", open)}
        >
          <SchemaForm
            schema={section.schema}
            rootSchema={section.root}
            value={value}
            onChange={onChange}
            idPrefix={idPrefix}
            basePath="recording"
            issues={issues}
            disabled={disabled}
            hiddenKeys={[...grouped]}
            fieldMeta={meta}
          />
        </PropertySection>
      ) : null}
    </SchemaDensityContext.Provider>
  );
}

function ModeNote({ value }: { value: JsonObject }) {
  const currentMode = typeof value.mode === "string" ? value.mode : "detailed";
  const modeInfo = (RECORDER_MODES as readonly string[]).includes(currentMode) ? MODE_INFO[currentMode as RecorderMode] : null;
  return (
    <p className="flex items-start gap-2 px-3 pt-2.5 pb-1 text-caption text-fg-tertiary">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <T source={"{value}下一次呼叫生效，不需重新載入。"} values={{ value: modeInfo ? (
          <>
            <T source={"<0>{currentMode}</0>：{hint}。"} values={{ currentMode, hint: modeInfo.hint }} slots={[<span className="machine text-fg-secondary" />]} />
          </>
        ) : null }} />
      </span>
    </p>
  );
}

/** 衝突／失敗的完整說明與「重新讀取」（不自動重送）；其他結果只顯示狀態。 */
function ResultMessage({ result, label, hasDraft, reloadBlock, onReload }: { result: RowResult | undefined; label: string; hasDraft: boolean; reloadBlock: string | null; onReload: () => void }) {
  if (!result) return null;
  if (result.status !== "conflict" && result.status !== "failed") {
    return (
      <div className="text-caption">
        <ResultChip result={result} />
      </div>
    );
  }
  let detail: ReactNode;
  if (result.status === "conflict") {
    detail = (
      <p className="text-fg-secondary">
        {t("{label}：伺服器已有更新的設定（REVISION_CONFLICT）；{value}", { label, value: hasDraft ? t("你的變更仍保留在草稿，重新讀取後會套到最新版上。") : t("這次沒有寫入。") })}
      </p>
    );
  } else {
    detail = (
      <>
        <p className="text-fg-secondary [overflow-wrap:anywhere]">
          <T source={"<0>{code}</0>：{message}"} values={{ code: result.code, message: tServer(result.message) }} slots={[<code className="machine text-fg-tertiary" />]} />
        </p>
        {result.outcomeUnknown ? <p className="text-warning">{t("Node 可能已套用：請重新讀取確認，不會自動重送。")}</p> : null}
        {!result.outcomeUnknown && result.hint ? <p className="text-fg-tertiary">{result.hint}</p> : null}
      </>
    );
  }
  return (
    <div className="grid gap-1 text-caption">
      <div className="flex flex-wrap items-center gap-2">
        <ResultChip result={result} />
        <span className={result.status === "conflict" ? "font-medium text-warning" : "font-medium text-danger"}>
          {result.status === "conflict" ? t("已被更新，請重新讀取") : result.outcomeUnknown ? t("遠端結果未知") : t("儲存失敗")}
        </span>
        <ActionButton size="sm" variant="secondary" icon={<RotateCcw aria-hidden />} onClick={onReload} disabledReason={reloadBlock} className="ml-auto">
          {t("重新讀取")}
        </ActionButton>
      </div>
      {detail}
    </div>
  );
}

/**
 * 右側檢視器：單一元件完整的 RecorderConfig（表單或 JSON），編輯同一份列草稿；
 * 儲存走同一條「依序 PATCH」路徑（只送變更欄位、帶 expected_revision、不自動重送）。
 */
export function RecorderInspector({
  row,
  draft,
  result,
  running,
  onChange,
  onSave,
  onRevert,
  onReload,
}: {
  row: TrackingRow;
  draft: RowDraft | undefined;
  result: RowResult | undefined;
  running: boolean;
  onChange: (row: TrackingRow, value: JsonObject) => void;
  onSave: (row: TrackingRow) => void;
  onRevert: (row: TrackingRow) => void;
  onReload: (row: TrackingRow) => void;
}) {
  const [mode, setMode] = useState<Mode>("form");
  const value = draft?.value ?? row.stored;
  const issues = recordingIssues(row.view, value);
  const diff = draft ? draftPatch(draft) : { patch: undefined, removedPaths: [] };
  const changed = Object.keys(diff.patch ?? {});
  const outdated = draft !== undefined && row.revision > draft.baseRevision;
  const kind = providerKind(row.providerId);
  const locked = running || row.stale;
  const reloadBlock = running ? t("儲存進行中，請稍候") : null;
  const saveReason = running
    ? t("儲存進行中，請稍候")
    : row.stale
      ? t("Node 離線：無法寫入")
      : !draft
        ? t("沒有變更")
        : issues.length > 0
          ? t("有 {issuesCount} 個問題需先修正", { issuesCount: issues.length })
          : !diff.patch
            ? t("變更只有移除欄位：PATCH 無法刪除欄位")
            : null;
  const recordingsHref = recordingsPath({ component_id: row.componentId, node_id: row.nodeId });
  const componentHref = componentPath(row.nodeId, row.componentId);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={kind.icon}
        art={kind.art}
        tone={kind.tone}
        title={row.label}
        status={<StatusBadge kind="component" value={row.state} />}
        description={
          <span className="grid gap-1">
            <span>
              {kind.label} · <code className="machine">{row.providerId}</code> · {row.nodeLabel}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <StatusBadge kind="recorder" value={row.recorderState} />
              {row.stale ? <Badge tone="warning">{t("Node 離線：無法寫入")}</Badge> : null}
              {row.test ? <SyntheticBadge kind="test" /> : null}
            </span>
          </span>
        }
        id={row.componentId}
      />
      <ToolStrip label={t("相關頁面")} className="min-h-9 gap-x-0.5 px-1.5">
        <Link to={recordingsHref} className={toolLink} title={t("這個元件最近的效能紀錄")}>
          <ScrollText aria-hidden />
          {t("最近紀錄")}
        </Link>
        <Link to={componentHref} className={toolLink} title={t("在元件頁開啟這個 instance（載入、呼叫預設與錄製設定）")}>
          <Boxes aria-hidden />
          {t("元件頁")}
        </Link>
      </ToolStrip>
      <PanelTabs
        tabs={[
          { id: "form", label: t("表單") },
          { id: "json", label: "JSON" },
        ]}
        value={mode}
        onChange={(id) => setMode(id === "json" ? "json" : "form")}
        idPrefix={TAB_PREFIX}
        label={t("編輯方式")}
        variant="underline"
      />
      <DockBody role="tabpanel" id={`${TAB_PREFIX}-panel-${mode}`} aria-labelledby={`${TAB_PREFIX}-tab-${mode}`}>
        <ModeNote value={value} />
        {mode === "form" ? (
          <RecorderSections row={row} value={value} onChange={(next) => onChange(row, next)} disabled={locked} />
        ) : (
          <div className="px-3 pt-1 pb-3">
            <JsonEditor
              id={`recorder-json-${safeKey(row.key)}`}
              label="recording JSON"
              value={value}
              accept={(next) => (isRecord(next) ? null : t("recording 必須是 JSON object"))}
              onChange={(next) => onChange(row, next as JsonObject)}
              issues={issues}
              rows={18}
              disabled={locked}
              description={t("儲存時只送出變更的欄位；array 整體替換、null 是字面值。")}
            />
          </div>
        )}
        {row.descriptor.parts.length > 0 ? (
          <PropertySection title={t("可用的 part 路徑")} icon={<Puzzle aria-hidden />} count={row.descriptor.parts.length} defaultOpen={false}>
            <ul className="grid max-h-48 gap-0.5 overflow-y-auto rounded-md border border-line-subtle bg-sunken px-3 py-2">
              {row.descriptor.parts.map((part) => (
                <li key={part.path} className="machine text-caption text-fg-secondary">
                  {part.path}
                </li>
              ))}
            </ul>
          </PropertySection>
        ) : null}
      </DockBody>

      <InspectorFooter
        note={
          <span aria-live="polite">
            {draft ? t("{changedCount} 個欄位已修改（基於 #{baseRevision}）", { changedCount: changed.length, baseRevision: draft.baseRevision }) : t("與已保存 #{revision} 一致", { revision: row.revision })}
          </span>
        }
      >
        <div className="grid w-full gap-2" aria-label={t("儲存錄製設定")} role="group">
          {outdated ? (
            <Callout tone="warning" title={t("伺服器已有 revision #{revision}（草稿基於 #{baseRevision}）", { revision: row.revision, baseRevision: draft.baseRevision })}>
              <p>{t("儲存時以 expected_revision 檢查，會回報「已被更新」；重新讀取會把你的修改套到最新版上。")}</p>
              <ActionButton size="sm" icon={<RotateCcw aria-hidden />} onClick={() => onReload(row)} disabledReason={reloadBlock}>
                {t("重新讀取")}
              </ActionButton>
            </Callout>
          ) : null}
          {diff.removedPaths.length > 0 ? <p className="text-caption text-warning">{t("移除了 {removedPaths}：PATCH 不會刪除欄位（伺服器保留原值）。", { removedPaths: formatList(diff.removedPaths) })}</p> : null}
          {draft && issues.length > 0 ? <p className="text-caption text-danger">{t("{issuesCount} 個問題阻擋儲存（伺服器會以 422 拒絕）。", { issuesCount: issues.length })}</p> : null}
          <ResultMessage result={result} label={row.label} hasDraft={draft !== undefined} reloadBlock={reloadBlock} onReload={() => onReload(row)} />
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              id={RECORDER_SAVE_ID}
              variant="primary"
              size="sm"
              icon={<Save aria-hidden />}
              pending={result?.status === "pending"}
              disabledReason={result?.status === "pending" ? null : saveReason}
              onClick={() => onSave(row)}
            >
              {t("儲存")}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="secondary"
              icon={<Undo2 aria-hidden />}
              disabledReason={running ? t("儲存進行中，請稍候") : !draft ? t("沒有變更") : null}
              onClick={() => onRevert(row)}
            >
              {t("捨棄修改")}
            </ActionButton>
          </div>
        </div>
      </InspectorFooter>
    </div>
  );
}
