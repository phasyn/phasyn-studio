import { RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { parseJson, type JsonParseError } from "@/lib/json";
import { validateValue, type JsonSchema, type SchemaIssue } from "@/lib/schema";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

interface Draft {
  /** 這段文字對應的外部值序列化；外部值改變（例如表單或套用 preset）時改顯示新值。 */
  base: string;
  text: string;
  error: JsonParseError | null;
}

function format(value: unknown): string {
  return value === undefined ? "" : (JSON.stringify(value, null, 2) ?? "");
}

/**
 * 進階 JSON 編輯器：語法錯誤時保留使用者文字、標出行列且不套用；語法正確即時套用到草稿。
 * 傳入 schema 時以同一份 schema 檢查並列出問題（伺服器仍是權威）。
 */
export function JsonEditor({
  id,
  label,
  value,
  onChange,
  schema,
  rootSchema,
  issues,
  rows = 10,
  disabled = false,
  description,
  className,
  hideLabel = false,
  labelledBy,
  accept,
}: {
  id: string;
  label: string;
  /** 由外部元素提供標籤時傳入其 id（不再渲染自己的 label）。 */
  labelledBy?: string;
  /** 結構檢查：回傳錯誤訊息時視同語法錯誤（保留文字、不套用）。 */
  accept?: (value: unknown) => string | null;
  value: unknown;
  onChange: (value: unknown) => void;
  schema?: unknown;
  rootSchema?: JsonSchema;
  /** 由呼叫端計算的問題（路徑已是完整路徑）；未提供時以 schema 自行檢查。 */
  issues?: readonly SchemaIssue[];
  rows?: number;
  disabled?: boolean;
  description?: ReactNode;
  className?: string;
  hideLabel?: boolean;
}) {
  const external = format(value);
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = draft !== null && draft.base === external ? draft : null;
  const text = active ? active.text : external;
  const parseError = active?.error ?? null;
  const schemaIssues = issues ?? (schema !== undefined && !parseError ? validateValue(schema, value, rootSchema) : []);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;

  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      {labelledBy ? null : (
        <label htmlFor={id} className={cn("text-data font-medium text-fg-secondary", hideLabel && "sr-only")}>
          {label}
        </label>
      )}
      <Textarea
        id={id}
        aria-labelledby={labelledBy}
        spellCheck={false}
        rows={rows}
        className={cn("machine min-h-24 text-caption leading-5", parseError && "border-danger")}
        value={text}
        disabled={disabled}
        aria-invalid={parseError || schemaIssues.length > 0 ? true : undefined}
        aria-describedby={[parseError || schemaIssues.length > 0 ? errorId : null, description ? helpId : null].filter(Boolean).join(" ") || undefined}
        onChange={(event) => {
          const next = event.target.value;
          const parsed = parseJson(next);
          const rejection = parsed.ok && accept ? accept(parsed.value) : null;
          if (parsed.ok && rejection) {
            setDraft({ base: external, text: next, error: { message: rejection, line: null, column: null } });
          } else if (parsed.ok) {
            setDraft({ base: format(parsed.value), text: next, error: null });
            onChange(parsed.value);
          } else {
            setDraft({ base: external, text: next, error: parsed.error });
          }
        }}
      />
      {parseError || schemaIssues.length > 0 ? (
        <div id={errorId} className="grid gap-1 text-caption" aria-live="polite">
          {parseError ? (
            <p className="text-danger">
              {t("{value}：{message}。尚未套用到草稿，上一份有效內容仍保留。", { value: parseError.line !== null ? t("JSON 語法錯誤（第 {line} 行第 {value} 欄）", { line: parseError.line, value: parseError.column ?? "?" }) : t("無法套用"), message: parseError.message })}
            </p>
          ) : null}
          {schemaIssues.slice(0, 12).map((issue, index) => (
            <p key={`${issue.path}-${index}`} className="text-danger">
              <T source={"{span}：{message}"} values={{ span: <span className="machine">{issue.path || t("（根）")}</span>, message: issue.message }} />
            </p>
          ))}
          {schemaIssues.length > 12 ? <p className="text-fg-tertiary">{t("另有 {schemaIssuesCount} 個問題", { schemaIssuesCount: schemaIssues.length - 12 })}</p> : null}
        </div>
      ) : null}
      {description ? (
        <p id={helpId} className="text-caption text-fg-tertiary">
          {description}
        </p>
      ) : null}
      {parseError ? (
        <div>
          <Button size="sm" variant="quiet" icon={<RotateCcw aria-hidden />} onClick={() => setDraft(null)}>
            {t("放棄未套用的文字")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
