// 搜尋與篩選：草稿在本元件、按「套用」才寫入 URL（查詢只依 URL）。since／until 輸入本地時間，送出 UTC RFC3339。
// 草稿＝「目前 URL 的篩選」＋「針對這份 URL 狀態的編輯」：套用或上一頁改變 URL 後，舊編輯自動作廢，
// 輸入框不重新掛載，所以按 Enter／套用後焦點留在原處。
// 版面：column＝左下「大綱」的單欄（動作列固定在面板底部）；grid＝中欄內嵌的多欄（大綱不可用時）。
import { RotateCcw, Search } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { FILTER_KEYS, FILTER_LABELS, localInputToUtc, utcToLocalInput, type FilterKey, type RecordingFilters } from "../model/filters";
import { t } from "@/i18n";

type Draft = Record<FilterKey, string>;
type TimeKey = "since" | "until";
const TIME_KEYS: readonly TimeKey[] = ["since", "until"];

function toDraft(filters: RecordingFilters): Draft {
  const draft = Object.fromEntries(FILTER_KEYS.map((key) => [key, filters[key] ?? ""])) as Draft;
  draft.since = utcToLocalInput(filters.since);
  draft.until = utcToLocalInput(filters.until);
  return draft;
}

const TEXT_FIELDS: ReadonlyArray<{ key: Exclude<FilterKey, "since" | "until" | "node_id">; placeholder: string; help?: string }> = [
  { key: "component_id", placeholder: t("例如 dit-main") },
  { key: "provider_id", placeholder: t("例如 synthetic.dit") },
  { key: "run_id", placeholder: "UUID" },
  { key: "call_id", placeholder: "UUID" },
  { key: "part", placeholder: t("例如 transformer.blocks.12"), help: t("有此 part 彙整的 recording") },
  { key: "error_code", placeholder: t("例如 GPU_OOM") },
  { key: "precision", placeholder: t("例如 bf16") },
  { key: "config_digest", placeholder: "sha256" },
];

/** 精簡欄位：12 px 標籤、32 px 輸入；說明與錯誤以 aria-describedby 關聯。 */
function FilterField({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | null;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : null;
  const errorId = error ? `${id}-error` : null;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid min-w-0 content-start gap-1">
      <label htmlFor={id} className="text-caption font-medium text-fg-secondary">
        {label}
      </label>
      {children(describedBy)}
      {error ? (
        <p id={errorId ?? undefined} className="text-caption text-danger">
          {error}
        </p>
      ) : null}
      {help ? (
        <p id={helpId ?? undefined} className="text-caption text-fg-tertiary">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function FiltersForm({
  filters,
  signature,
  onApply,
  nodeOptions,
  layout = "column",
  submitLabel = t("套用"),
  note,
  className,
}: {
  filters: RecordingFilters;
  /** 目前 URL 篩選的穩定字串；改變時（套用、上一頁）丟棄舊編輯。 */
  signature: string;
  onApply: (next: RecordingFilters) => void;
  nodeOptions: ReadonlyArray<{ id: string; label: string }>;
  layout?: "column" | "grid";
  submitLabel?: string;
  /** 動作列上方的一行說明（例如「套用後回到紀錄列表」）。 */
  note?: ReactNode;
  className?: string;
}) {
  const formId = useId();
  const listId = useId();
  const [edits, setEdits] = useState<{ base: string; values: Partial<Draft> }>({ base: signature, values: {} });
  const [errors, setErrors] = useState<Partial<Record<FilterKey, string>>>({});
  const timeInputs = useRef<Record<TimeKey, HTMLInputElement | null>>({ since: null, until: null });
  const activeEdits = edits.base === signature ? edits.values : {};
  const draft: Draft = { ...toDraft(filters), ...activeEdits };

  const set = (key: FilterKey, value: string) => setEdits({ base: signature, values: { ...activeEdits, [key]: value } });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Partial<Record<FilterKey, string>> = {};
    const next: RecordingFilters = {};
    for (const key of FILTER_KEYS) {
      if (key === "since" || key === "until") continue;
      const value = draft[key].trim();
      if (value) next[key] = value;
    }
    for (const key of TIME_KEYS) {
      // A partly typed datetime-local reads as "" (validity.badInput): refuse it rather than drop the condition silently
      if (timeInputs.current[key]?.validity.badInput) {
        nextErrors[key] = t("時間格式不正確（YYYY-MM-DDTHH:mm）");
        continue;
      }
      try {
        const utc = localInputToUtc(draft[key]);
        if (utc) next[key] = utc;
      } catch {
        nextErrors[key] = t("時間格式不正確（YYYY-MM-DDTHH:mm）");
      }
    }
    if (next.since && next.until && next.since > next.until) nextErrors.until = t("「迄」早於「起」");
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onApply(next);
  };

  const reset = () => {
    setEdits({ base: signature, values: {} });
    setErrors({});
    onApply({});
  };

  const column = layout === "column";
  return (
    <form
      id={formId}
      onSubmit={submit}
      aria-label={t("搜尋與篩選紀錄")}
      noValidate
      className={cn("grid min-w-0 gap-x-3 gap-y-2.5 p-3", column ? "pb-0" : "grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]", className)}
    >
      <FilterField id={`${formId}-node`} label={FILTER_LABELS.node_id} help={t("可輸入 node_id；清單顯示已知 Node 名稱。")}>
        {(describedBy) => (
          <>
            <Input
              compact
              id={`${formId}-node`}
              list={listId}
              value={draft.node_id}
              onChange={(event) => set("node_id", event.target.value)}
              placeholder="node_id"
              className="machine"
              aria-describedby={describedBy}
              autoComplete="off"
            />
            <datalist id={listId}>
              {nodeOptions.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
            </datalist>
          </>
        )}
      </FilterField>
      {TEXT_FIELDS.map((field) => (
        <FilterField key={field.key} id={`${formId}-${field.key}`} label={FILTER_LABELS[field.key]} help={field.help}>
          {(describedBy) => (
            <Input
              compact
              id={`${formId}-${field.key}`}
              value={draft[field.key]}
              onChange={(event) => set(field.key, event.target.value)}
              placeholder={field.placeholder}
              className="machine"
              aria-describedby={describedBy}
              autoComplete="off"
            />
          )}
        </FilterField>
      ))}
      {TIME_KEYS.map((key) => (
        <FilterField key={key} id={`${formId}-${key}`} label={FILTER_LABELS[key]} error={errors[key] ?? null} help={key === "until" ? t("以本地時間輸入；查詢以 UTC 傳送。") : undefined}>
          {(describedBy) => (
            <Input
              ref={(node) => {
                timeInputs.current[key] = node;
              }}
              compact
              id={`${formId}-${key}`}
              type="datetime-local"
              step={1}
              value={draft[key]}
              onChange={(event) => set(key, event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={errors[key] ? true : undefined}
              className="machine"
            />
          )}
        </FilterField>
      ))}
      <div
        className={cn(
          "grid gap-1.5",
          column ? "sticky bottom-0 -mx-3 border-t border-line-subtle bg-surface px-3 py-2" : "col-span-full border-t border-line-subtle pt-2.5",
        )}
      >
        {note ? <p className="text-caption text-fg-tertiary">{note}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" icon={<Search aria-hidden />} className="pointer-coarse:min-h-11">
            {submitLabel}
          </Button>
          <Button type="button" size="sm" icon={<RotateCcw aria-hidden />} onClick={reset} className="pointer-coarse:min-h-11">
            {t("清除")}
          </Button>
        </div>
      </div>
    </form>
  );
}
