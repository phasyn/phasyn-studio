import { isListed } from "@/lib/json";
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  FlaskConical,
  LoaderCircle,
  RotateCcw,
  Save,
  Server,
  SlidersHorizontal,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import {
  changedKeys,
  draftValues,
  LOG_LEVELS,
  MODE_INFO,
  RECORDER_MODES,
  rowAnchorId,
  selectionState,
  TOGGLE_FIELDS,
  traceSummary,
  type Drafts,
  type RowResult,
  type SelectionState,
  type TrackingGroup,
  type TrackingRow,
} from "./model";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";
import { failureText } from "@/lib/errors";

const COLUMNS = 10;

function TriCheckbox({ state, onChange, label, disabled, title }: { state: SelectionState; onChange: (on: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <label
      className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors duration-(--duration-fast) hover:bg-raised active:bg-sunken active:duration-0 has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent"
      title={title}
    >
      <input
        ref={ref}
        type="checkbox"
        className="size-4 cursor-pointer accent-action disabled:cursor-not-allowed"
        checked={state === "all"}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.checked); }}
        aria-label={label}
      />
    </label>
  );
}

function Chip({ icon: Icon, className, spin, title, children }: { icon: LucideIcon; className?: string; spin?: boolean; title?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-caption whitespace-nowrap", className)} title={title}>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", ((spin === true) ? "animate-spin" : spin))} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** 逐列結果：圖示＋文字（不只靠顏色）；完整原因在 title 與螢幕報讀文字。 */
export function ResultChip({ result }: { result: RowResult | undefined }) {
  if (!result) return null;
  switch (result.status) {
    case "queued":
      return (
        <Chip icon={CircleDashed} className="text-fg-tertiary">
          {t("等待中")}
        </Chip>
      );
    case "pending":
      return (
        <Chip icon={LoaderCircle} spin className="text-info">
          {t("儲存中")}
        </Chip>
      );
    case "reloading":
      return (
        <Chip icon={LoaderCircle} spin className="text-info">
          {t("讀取中")}
        </Chip>
      );
    case "saved":
      return (
        <Chip icon={CircleCheck} className="text-success" title={t("已儲存 revision #{revision}（{fields}）；下一次呼叫生效", { revision: result.revision, fields: formatList(result.fields) })}>
          {t("已儲存 #{revision}", { revision: result.revision })}
        </Chip>
      );
    case "skipped":
      return (
        <Chip icon={CircleSlash} className="text-fg-tertiary" title={result.reason}>
          {result.short}
          <span className="sr-only">{t("：{reason}", { reason: result.reason })}</span>
        </Chip>
      );
    case "conflict":
      return (
        <Chip icon={TriangleAlert} className="text-warning">
          {t("已被更新")}
        </Chip>
      );
    case "failed":
      return (
        <Chip icon={CircleX} className="text-danger" title={failureText(result.code, result.message)}>
          {result.outcomeUnknown ? t("結果未知") : t("失敗")}
        </Chip>
      );
    case "stopped":
      return (
        <Chip icon={CircleSlash} className="text-fg-tertiary" title={t("批次已停止：這個元件的請求沒有送出")}>
          {t("未送出")}
        </Chip>
      );
  }
}

/** 衝突／失敗的說明列：完整錯誤與「重新讀取」（不自動重送）。 */
function ProblemRow({ row, result, hasDraft, onReload, reloadDisabled }: { row: TrackingRow; result: RowResult; hasDraft: boolean; onReload: () => void; reloadDisabled: string | null }) {
  if (result.status !== "conflict" && result.status !== "failed") return null;
  return (
    <tr className="bg-sunken/50">
      <td colSpan={COLUMNS} className="border-b border-line-subtle px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
          {result.status === "conflict" ? (
            <>
              <span className="inline-flex items-center gap-1.5 font-medium text-warning">
                <TriangleAlert aria-hidden className="size-3.5" />
                {t("已被更新，請重新讀取")}
              </span>
              <span className="text-fg-secondary">
                {t("{label}：伺服器已有更新的設定（REVISION_CONFLICT）；{value}", { label: row.label, value: hasDraft ? t("你的變更仍保留在草稿，重新讀取後會套到最新版上。") : t("這次批次沒有寫入。") })}
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 font-medium text-danger">
                <CircleX aria-hidden className="size-3.5" />
                {result.outcomeUnknown ? t("遠端結果未知") : t("儲存失敗")}
              </span>
              <code className="machine text-fg-tertiary">{result.code}</code>
              <span className="min-w-0 text-fg-secondary [overflow-wrap:anywhere]">{tServer(result.message)}</span>
              {result.outcomeUnknown ? <span className="text-warning">{t("Node 可能已套用：請重新讀取確認，不會自動重送。")}</span> : null}
              {!result.outcomeUnknown && (result.hint != null && result.hint !== "") ? <span className="text-fg-tertiary">{result.hint}</span> : null}
            </>
          )}
          <ActionButton size="sm" variant="secondary" icon={<RotateCcw aria-hidden />} onClick={onReload} disabledReason={reloadDisabled} className="min-h-7">
            {t("重新讀取")}
          </ActionButton>
        </div>
      </td>
    </tr>
  );
}

export interface TrackingTableProps {
  groups: readonly TrackingGroup[];
  drafts: Drafts;
  results: Readonly<Record<string, RowResult>>;
  /** 批次套用勾選的列。 */
  selected: ReadonlySet<string>;
  /** 右側檢視器目前開啟的列。 */
  inspectedKey: string | null;
  running: boolean;
  onSelect: (keys: readonly string[], on: boolean) => void;
  onEdit: (row: TrackingRow, key: string, value: unknown) => void;
  onSave: (row: TrackingRow) => void;
  onRevert: (row: TrackingRow) => void;
  onInspect: (row: TrackingRow) => void;
  onReload: (row: TrackingRow) => void;
}

const DIRTY_CELL = "bg-warning/8 shadow-[inset_2px_0_0_var(--color-warning)]";

/**
 * 依 Node 分組的錄製設定表：模式、常用開關、log 等級可直接修改（成為該列草稿），其他欄位在右側檢視器。
 * 表格容器是 scroll owner、表頭固定；檢視器開啟的列用選取樣式，批次勾選的列另以淡底標示。
 * 容器是 positioned（relative）：列裡的 sr-only（position: absolute）以表格捲動區為準，不會跑到文件層撐出捲軸
 * （否則整個 app 會往上捲、下半部留白）。
 */
export function TrackingTable({ groups, drafts, results, selected, inspectedKey, running, onSelect, onEdit, onSave, onRevert, onInspect, onReload }: TrackingTableProps) {
  const visibleKeys = groups.flatMap((group) => group.rows.filter((row) => !row.stale).map((row) => row.key));
  return (
    <TableScroll label={t("各元件的錄製設定")} className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
      <Table className="min-w-[76rem] table-fixed [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
        <caption className="sr-only">{t("各 Node 元件 instance 的 recorder 設定；修改後成為該列草稿，按儲存才寫入。")}</caption>
        <colgroup>
          <col className="w-12" />
          <col />
          <col className="w-22" />
          <col className="w-24" />
          <col className="w-30" />
          <col className="w-32" />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-16" />
          <col className="w-44" />
        </colgroup>
        <thead>
          <tr>
            <Th scope="col" className="px-2 first:pl-2">
              <TriCheckbox
                state={selectionState(selected, visibleKeys)}
                onChange={(on) => { onSelect(visibleKeys, on); }}
                label={t("選取所有顯示中的元件")}
                disabled={visibleKeys.length === 0}
              />
            </Th>
            <Th scope="col">{t("元件")}</Th>
            <Th scope="col">provider</Th>
            <Th scope="col">{t("狀態")}</Th>
            <Th scope="col">{t("模式")}</Th>
            <Th scope="col">
              <span className="flex gap-1">
                {TOGGLE_FIELDS.map((toggle) => (
                  <span key={toggle.key} className="w-12 text-center" title={t("{label}（{key}）", { label: toggle.label, key: toggle.key })}>
                    {toggle.short}
                  </span>
                ))}
              </span>
            </Th>
            <Th scope="col">log</Th>
            <Th scope="col" title={t("trace_steps · trace_parts · shapes／stack")}>
              trace
            </Th>
            <Th scope="col" title={t("已保存的 stored_revision")}>
              rev
            </Th>
            <Th scope="col">{t("結果與操作")}</Th>
          </tr>
        </thead>
        {groups.map((group) => {
          const groupKeys = group.rows.filter((row) => !row.stale).map((row) => row.key);
          return (
            <tbody key={group.node.node_id}>
              <tr>
                <th scope="colgroup" colSpan={COLUMNS} className="border-b border-line-subtle bg-surface px-2 py-1 text-left text-data font-semibold text-fg">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <TriCheckbox
                      state={selectionState(selected, groupKeys)}
                      onChange={(on) => { onSelect(groupKeys, on); }}
                      label={t("選取 {label} 的所有顯示中元件", { label: group.node.label })}
                      disabled={groupKeys.length === 0}
                      {...(group.node.stale ? { title: t("Node 離線：無法寫入") } : {})}
                    />
                    <Server aria-hidden className="size-4 text-fg-tertiary" />
                    <span>{group.node.label}</span>
                    <StatusBadge kind="directory" value={group.node.liveness === "unknown" ? "offline" : group.node.liveness} />
                    {group.node.stale ? <span className="text-caption font-normal text-warning">{t("顯示最後快照；無法寫入")}</span> : null}
                    <span className="ml-auto machine text-caption font-normal text-fg-tertiary">
                      {group.rows.length}/{group.total}
                    </span>
                  </span>
                </th>
              </tr>
              {group.rows.length === 0 ? (
                <tr>
                  <Td colSpan={COLUMNS} className="text-caption text-fg-tertiary">
                    {group.total === 0 ? t("此 Node 沒有元件 instance。") : t("篩選後沒有符合的元件。")}
                  </Td>
                </tr>
              ) : (
                group.rows.map((row) => {
                  const draft = drafts[row.key];
                  const values = draftValues(row, draft);
                  const changed = new Set(changedKeys(draft));
                  const result = results[row.key];
                  const lockReason = row.stale ? t("Node 離線：無法寫入") : running ? t("儲存進行中，請稍候") : null;
                  const trace = traceSummary(values);
                  const mode = values.mode;
                  const knownMode = isListed(mode, RECORDER_MODES);
                  const modeHint = knownMode ? MODE_INFO[mode].hint : t("目前值不在允許清單");
                  const isSelected = selected.has(row.key);
                  const inspected = row.key === inspectedKey;
                  const outdated = draft !== undefined && row.revision > draft.baseRevision;
                  const kind = providerKind(row.providerId);
                  return (
                    <Fragment key={row.key}>
                      <Tr selected={inspected} className={cn("[&>td]:align-middle", isSelected && !inspected && "bg-brand-soft", row.stale && "opacity-80")}>
                        <Td className="px-2 py-1 first:pl-2">
                          <TriCheckbox
                            state={isSelected ? "all" : "none"}
                            onChange={(on) => { onSelect([row.key], on); }}
                            label={t("選取 {label}", { label: row.label })}
                            disabled={row.stale}
                            {...(row.stale ? { title: t("Node 離線：無法寫入") } : {})}
                          />
                        </Td>
                        <Td className="py-1">
                          <button
                            id={rowAnchorId(row.key)}
                            type="button"
                            aria-pressed={inspected}
                            onClick={() => { onInspect(row); }}
                            className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left hover:text-action-hover"
                            title={t("{label}（{componentId}）：在右側檢視器開啟錄製設定", { label: row.label, componentId: row.componentId })}
                          >
                            <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
                            <span className="min-w-0 truncate font-medium text-fg">{row.label}</span>
                            {row.label !== row.componentId ? <code className="min-w-0 shrink truncate machine text-caption text-fg-tertiary">{row.componentId}</code> : null}
                            {row.test ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-caption text-warning" title={t("測試元件／合成示例")}>
                                <FlaskConical aria-hidden className="size-3.5" />
                                <T source={"測試<0>元件／合成示例</0>"} slots={[<span key="slot-0" className="sr-only" />]} />
                              </span>
                            ) : null}
                          </button>
                        </Td>
                        <Td>
                          <code className="block truncate machine text-fg-secondary" title={`${row.providerId} · runtime ${row.runtimeId}`}>
                            {row.providerId}
                          </code>
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-1">
                            <StatusBadge kind="component" value={row.state} />
                            {row.recorderState === "degraded" ? (
                              <span className="inline-flex text-warning" title={t("紀錄降級（recorder_state=degraded）")}>
                                <TriangleAlert aria-hidden className="size-3.5" />
                                <span className="sr-only">{t("紀錄降級")}</span>
                              </span>
                            ) : null}
                          </span>
                        </Td>
                        <Td className={cn("py-1", changed.has("mode") && DIRTY_CELL)}>
                          <Select
                            aria-label={t("錄製模式：{label}", { label: row.label })}
                            value={values.mode}
                            disabled={lockReason !== null}
                            title={lockReason ?? modeHint}
                            onChange={(event) => { onEdit(row, "mode", event.target.value); }}
                            className="min-h-8 py-1 pr-7 pl-2 text-data"
                          >
                            {knownMode ? null : <option value={values.mode}>{t("目前值 {value}", { value: values.mode || t("（空）") })}</option>}
                            {RECORDER_MODES.map((mode) => (
                              <option key={mode} value={mode}>
                                {mode}
                              </option>
                            ))}
                          </Select>
                          {changed.has("mode") ? <span className="sr-only">{t("（未儲存）")}</span> : null}
                        </Td>
                        <Td className="py-1">
                          <span className="flex gap-1">
                            {TOGGLE_FIELDS.map((toggle) => (
                              <label
                                key={toggle.key}
                                className={cn(
                                  "inline-flex h-8 w-12 cursor-pointer items-center justify-center rounded-md transition-colors duration-(--duration-fast) hover:bg-raised active:bg-sunken active:duration-0 has-[:disabled]:cursor-not-allowed",
                                  changed.has(toggle.key) && DIRTY_CELL,
                                )}
                                title={lockReason ?? t("{label}（{key}）", { label: toggle.label, key: toggle.key })}
                              >
                                <input
                                  type="checkbox"
                                  className="size-4 cursor-pointer accent-action disabled:cursor-not-allowed"
                                  checked={values[toggle.key]}
                                  disabled={lockReason !== null}
                                  onChange={(event) => { onEdit(row, toggle.key, event.target.checked); }}
                                  aria-label={t("{label}：{label2}{value}", { label: toggle.label, label2: row.label, value: changed.has(toggle.key) ? t("（未儲存）") : "" })}
                                />
                              </label>
                            ))}
                          </span>
                        </Td>
                        <Td className={cn("py-1", changed.has("log_level") && DIRTY_CELL)}>
                          <Select
                            aria-label={t("log 等級：{label}", { label: row.label })}
                            value={values.log_level}
                            disabled={lockReason !== null}
                            title={lockReason ?? t("只篩選文字 log；必要錯誤與 counter 不受影響")}
                            onChange={(event) => { onEdit(row, "log_level", event.target.value); }}
                            className="min-h-8 py-1 pr-7 pl-2 text-data"
                          >
                            {(LOG_LEVELS as readonly string[]).includes(values.log_level) ? null : <option value={values.log_level}>{t("目前值 {value}", { value: values.log_level || t("（空）") })}</option>}
                            {LOG_LEVELS.map((level) => (
                              <option key={level} value={level}>
                                {level}
                              </option>
                            ))}
                          </Select>
                          {changed.has("log_level") ? <span className="sr-only">{t("（未儲存）")}</span> : null}
                        </Td>
                        <Td>
                          <span className={cn("block truncate text-caption", trace.active ? "text-fg-secondary" : "text-fg-disabled")} title={trace.title}>
                            {trace.text}
                            {trace.active ? null : <span className="sr-only">{t("（mode 不是 trace，不生效）")}</span>}
                          </span>
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-0.5 machine text-fg-secondary" title={outdated ? t("伺服器已有 #{revision}；草稿基於 #{baseRevision}", { revision: row.revision, baseRevision: draft.baseRevision }) : t("已保存 revision #{revision}", { revision: row.revision })}>
                            #{row.revision}
                            {outdated ? (
                              <>
                                <TriangleAlert aria-hidden className="size-3.5 text-warning" />
                                <span className="sr-only">{t("草稿基於較舊的 #{baseRevision}", { baseRevision: draft.baseRevision })}</span>
                              </>
                            ) : null}
                          </span>
                        </Td>
                        <Td className="py-1">
                          <span className="flex min-w-0 items-center gap-1">
                            <Button
                              size="icon-sm"
                              variant="quiet"
                              aria-label={t("在檢視器開啟錄製設定：{label}", { label: row.label })}
                              title={t("在右側檢視器編輯全部 RecorderConfig 欄位")}
                              onClick={() => { onInspect(row); }}
                            >
                              <SlidersHorizontal aria-hidden />
                            </Button>
                            {draft ? (
                              <>
                                <ActionButton
                                  size="icon-sm"
                                  variant="secondary"
                                  icon={<Save aria-hidden />}
                                  aria-label={t("儲存 {label} 的錄製設定", { label: row.label })}
                                  title={t("儲存（{changedCount} 個欄位）", { changedCount: changed.size })}
                                  pending={result?.status === "pending"}
                                  disabledReason={result?.status === "pending" ? null : lockReason}
                                  onClick={() => { onSave(row); }}
                                />
                                <ActionButton
                                  size="icon-sm"
                                  variant="quiet"
                                  icon={<Undo2 aria-hidden />}
                                  aria-label={t("還原 {label} 的修改", { label: row.label })}
                                  title={t("還原為已保存值")}
                                  disabledReason={running ? t("儲存進行中，請稍候") : null}
                                  onClick={() => { onRevert(row); }}
                                />
                              </>
                            ) : null}
                            <ResultChip result={result} />
                          </span>
                        </Td>
                      </Tr>
                      {result ? (
                        <ProblemRow row={row} result={result} hasDraft={draft !== undefined} onReload={() => { onReload(row); }} reloadDisabled={running ? t("儲存進行中，請稍候") : null} />
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          );
        })}
      </Table>
    </TableScroll>
  );
}
