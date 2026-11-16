// 追蹤設定中欄的精簡工具列：錄製模式說明、批次套用、儲存狀態（32 px 控制；行為與寫入語意不變）。
import { CircleStop, ListChecks, LoaderCircle, PencilLine, Save, Undo2, X } from "lucide-react";
import type { ReactNode } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { ToolSeparator, ToolStrip } from "@/components/workbench/ToolStrip";
import { cn } from "@/lib/cn";
import { LOG_LEVELS, MODE_INFO, RECORDER_MODES, TOGGLE_FIELDS, type BulkValues, type ToggleKey } from "./model";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function toggleOption(value: boolean | undefined): string {
  return value === undefined ? "" : value ? "on" : "off";
}

function withToggle(values: BulkValues, key: ToggleKey, option: string): BulkValues {
  const next: BulkValues = { ...values };
  if (option === "") delete next[key];
  else next[key] = option === "on";
  return next;
}

/** 工具列下拉（32 px）：可見的短標籤在左側。 */
export function StripSelect({
  id,
  label,
  value,
  onChange,
  children,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-caption whitespace-nowrap text-fg-tertiary">
        {label}
      </label>
      <div className={cn("min-w-28", className)}>
        <Select compact id={id} value={value} onChange={(event) => onChange(event.target.value)} className="w-auto min-w-full">
          {children}
        </Select>
      </div>
    </div>
  );
}

/** 錄製模式說明（工具列「模式說明」按鈕展開）。 */
export function ModeLegend({ id, hidden }: { id: string; hidden: boolean }) {
  return (
    <div id={id} role="region" aria-label={t("錄製模式說明")} hidden={hidden} className="shrink-0 border-b border-line-subtle bg-sunken/60 px-4 py-2">
      <dl className="grid max-w-3xl grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
        {RECORDER_MODES.map((mode) => (
          <div key={mode} className="contents">
            <dt className="machine text-fg">{MODE_INFO[mode].label}</dt>
            <dd className="m-0 text-fg-secondary">{MODE_INFO[mode].hint}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 text-caption text-fg-tertiary">{t("mode 只改變量測，不改模型精度、batch 或步數；log 等級只篩選文字 log。")}</p>
    </div>
  );
}

/** 批次套用：勾選列之後出現；每個元件一個 PATCH、依序送出（見 planBulk）。 */
export function BulkStrip({
  count,
  hidden,
  values,
  onChange,
  onApply,
  onClear,
  blockReason,
  pending,
}: {
  count: number;
  hidden: number;
  values: BulkValues;
  onChange: (next: BulkValues) => void;
  onApply: () => void;
  onClear: () => void;
  blockReason: string | null;
  pending: boolean;
}) {
  return (
    <ToolStrip label={t("批次套用")} className="gap-x-3 bg-brand-soft px-3 animate-rise-in">
      <p className="flex items-center gap-1.5 text-data font-semibold text-fg">
        <ListChecks aria-hidden className="size-4 text-action-fg" />
        <T source={"已選 <0>{count}</0> 個{value}"} values={{ count, value: hidden > 0 ? <span className="text-caption font-normal text-fg-tertiary">{t("（另 {hidden} 個被篩選隱藏或離線，不會套用）", { hidden })}</span> : null }} slots={[<span className="machine" />]} />
      </p>
      <ToolSeparator />
      <StripSelect id="bulk-mode" label={t("模式")} value={values.mode ?? ""} onChange={(next) => onChange({ ...values, mode: next || undefined })}>
        <option value="">{t("不變")}</option>
        {RECORDER_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </StripSelect>
      {TOGGLE_FIELDS.map((toggle) => (
        <StripSelect
          key={toggle.key}
          id={`bulk-${toggle.key}`}
          label={toggle.short}
          value={toggleOption(values[toggle.key])}
          onChange={(next) => onChange(withToggle(values, toggle.key, next))}
          className="min-w-22"
        >
          <option value="">{t("不變")}</option>
          <option value="on">{t("開")}</option>
          <option value="off">{t("關")}</option>
        </StripSelect>
      ))}
      <StripSelect id="bulk-log" label="log" value={values.log_level ?? ""} onChange={(next) => onChange({ ...values, log_level: next || undefined })}>
        <option value="">{t("不變")}</option>
        {LOG_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </StripSelect>
      <ToolSeparator />
      <span className="flex items-center gap-2">
        <ActionButton variant="primary" size="sm" pending={pending} disabledReason={pending ? null : blockReason} onClick={onApply}>
          {t("套用到選取的 {count} 個元件", { count })}
        </ActionButton>
        <Button size="sm" variant="quiet" icon={<X aria-hidden />} onClick={onClear}>
          {t("取消選取")}
        </Button>
      </span>
      {values.mode === "trace" ? (
        <p className="basis-full text-caption text-warning">{t("trace 會對指定 step 啟用 torch.profiler，成本高；只在需要 kernel／memcpy 細節時開啟。")}</p>
      ) : null}
    </ToolStrip>
  );
}

/** 儲存狀態：未儲存數、依序儲存進度、「儲存全部」、停止送出／全部還原、上次結果。 */
export function SaveStrip({
  summaryId,
  progress,
  dirtyCount,
  hiddenDirty,
  running,
  saveAllPending,
  showSaveAll,
  summary,
  onSaveAll,
  onStop,
  onRevertAll,
  onClearResults,
}: {
  summaryId: string;
  progress: { done: number; total: number } | null;
  dirtyCount: number;
  hiddenDirty: number;
  running: boolean;
  /** 「儲存全部」觸發的這一批正在進行（按鈕保持掛載並顯示進行中）。 */
  saveAllPending: boolean;
  showSaveAll: boolean;
  summary: string;
  onSaveAll: () => void;
  onStop: () => void;
  onRevertAll: () => void;
  onClearResults: () => void;
}) {
  return (
    <ToolStrip label={t("儲存狀態")} className="gap-x-3 px-3">
      {progress ? (
        <span className="inline-flex items-center gap-2 text-data text-info">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          <span>
            <T source={"依序儲存中 <0>{done}／{total}</0>"} values={{ done: progress.done, total: progress.total }} slots={[<span className="machine" />]} />
          </span>
          {/* 實測比例（已完成／總數），數字在左側文字。 */}
          <span aria-hidden className="relative block h-1.5 w-24 overflow-hidden rounded-full bg-line-subtle">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-brand-gradient transition-[width] duration-(--duration-base) ease-linear animate-shimmer"
              style={{ width: `${progress.total > 0 ? Math.max((progress.done / progress.total) * 100, 4) : 4}%` }}
            />
          </span>
        </span>
      ) : dirtyCount > 0 ? (
        <span className="inline-flex items-center gap-1.5 text-data text-warning">
          <PencilLine aria-hidden className="size-4" />
          <T source={"<0>{dirtyCount}</0> 個元件有未儲存的變更{value}"} values={{ dirtyCount, value: hiddenDirty > 0 ? <span className="text-caption text-fg-tertiary">{t("（{hiddenDirty} 個被篩選隱藏）", { hiddenDirty })}</span> : null }} slots={[<span className="machine" />]} />
        </span>
      ) : null}
      {showSaveAll ? (
        <ActionButton
          variant="primary"
          size="sm"
          icon={<Save aria-hidden />}
          pending={saveAllPending}
          disabledReason={running ? (saveAllPending ? null : t("儲存進行中，請稍候")) : null}
          onClick={onSaveAll}
        >
          {t("儲存全部（{dirtyCount} 個 PATCH，依序）", { dirtyCount })}
        </ActionButton>
      ) : null}
      {running ? (
        <Button size="sm" icon={<CircleStop aria-hidden />} onClick={onStop} title={t("不再送出尚未開始的請求；已送出的那一個照實回報")}>
          {t("停止送出")}
        </Button>
      ) : dirtyCount > 0 ? (
        <Button size="sm" variant="quiet" icon={<Undo2 aria-hidden />} onClick={onRevertAll}>
          {t("全部還原")}
        </Button>
      ) : null}
      {!progress && summary ? (
        <span id={summaryId} tabIndex={-1} className="ml-auto inline-flex items-center gap-2 rounded-sm text-caption text-fg-secondary outline-none focus-visible:outline-2">
          <T source={"上次儲存：{summary}<0>清除結果</0>"} values={{ summary }} slots={[<Button size="sm" variant="quiet" onClick={onClearResults} />]} />
        </span>
      ) : null}
    </ToolStrip>
  );
}
