import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { isRecord, type JsonObject } from "@/lib/json";
import { objectProperties, type SchemaIssue } from "@/lib/schema";
import { JsonEditor } from "./JsonEditor";
import { SchemaForm } from "./SchemaForm";
import { t } from "@/i18n";

const EMPTY_ITEMS = [] as const;

/**
 * 呼叫參數（parameters_schema）：表單與 JSON 兩種編輯方式，同一份值。
 * 未填的欄位沿用元件的 invoke 預設（Node 端：invoke defaults 疊上本次 parameters）。
 */
export function ParametersEditor({
  schema,
  value,
  onChange,
  idPrefix,
  issues = EMPTY_ITEMS,
  disabled = false,
  label: labelProp,
}: {
  schema: unknown;
  value: JsonObject;
  onChange: (next: JsonObject) => void;
  idPrefix: string;
  issues?: readonly SchemaIssue[];
  disabled?: boolean;
  label?: string;
}) {
  const label = labelProp ?? t("呼叫參數");
  const hasFields = objectProperties(schema).length > 0;
  const [mode, setMode] = useState<"form" | "json">(hasFields ? "form" : "json");
  const groupId = useId();
  const rootSchema = isRecord(schema) ? schema : undefined;
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={groupId} className="text-data font-semibold text-fg">
          {label}
        </span>
        <div role="radiogroup" aria-labelledby={groupId} className="inline-flex rounded-md border border-line bg-sunken p-0.5">
          {(["form", "json"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={mode === item}
              disabled={item === "form" && !hasFields}
              title={item === "form" && !hasFields ? t("parameters_schema 沒有宣告欄位，只能用 JSON 編輯") : undefined}
              onClick={() => { setMode(item); }}
              className={cn(
                "min-h-8 rounded-sm px-3 text-data transition-colors duration-150 disabled:cursor-not-allowed disabled:text-fg-disabled",
                mode === item ? "bg-raised text-fg" : "text-fg-secondary hover:text-fg",
              )}
            >
              {item === "form" ? t("表單") : "JSON"}
            </button>
          ))}
        </div>
      </div>
      {mode === "form" && hasFields ? (
        <SchemaForm
          schema={schema}
          {...(rootSchema === undefined ? {} : { rootSchema })}
          value={value}
          onChange={onChange}
          idPrefix={idPrefix}
          issues={issues}
          disabled={disabled}
          allowUnset
        />
      ) : (
        <JsonEditor
          id={`${idPrefix}-json`}
          label={t("{label}（JSON）", { label })}
          value={value}
          accept={(next) => (isRecord(next) ? null : t("參數必須是 JSON object"))}
          onChange={(next) => { if (isRecord(next)) onChange(next); }}
          issues={issues}
          rows={6}
          disabled={disabled}
          description={t("未填的欄位沿用元件的 invoke 預設值。")}
        />
      )}
      {!hasFields ? <p className="text-caption text-fg-tertiary">{t("此元件的 parameters_schema 沒有宣告欄位；仍可用 JSON 傳入，由伺服器檢查。")}</p> : null}
    </div>
  );
}
