import { optionalField } from "@/lib/json";
// The input of one schema field, chosen by its control kind (see controlKind in @/lib/schema): fixed and null-only
// values read-only, enums and optional booleans as a select, a switch, numbers, text, comma lists, else JSON.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select, Switch } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { displayText, previewValue } from "@/lib/json";
import { initialValueFor, scalarListItemKind, selectModel, type ControlKind, type FieldInfo, type JsonSchema, type SchemaIssue } from "@/lib/schema";
import { JsonEditor } from "../JsonEditor";
import { ListControl, NullableRow, NumberControl } from "./inputs";
import { t } from "@/i18n";

export interface FieldControlProps {
  kind: ControlKind;
  info: FieldInfo;
  /** The field name (the schema key). */
  name: string;
  id: string;
  labelId: string;
  value: unknown;
  onChange: (next: unknown) => void;
  rootSchema?: JsonSchema;
  required: boolean;
  allowUnset: boolean;
  /** The select offers "unset" (the field may be cleared and is set now). */
  canUnset: boolean;
  /** Disabled, read-only or unsupported. */
  locked: boolean;
  invalid: boolean;
  describedBy?: string;
  compact: boolean;
  /** The field's issues and those below it (shown inside the JSON editor). */
  issues: readonly SchemaIssue[];
  /** The null switch beside a nullable number, text or list input; null otherwise. */
  nullToggle: ReactNode;
  /** The placeholder of an unset field that has a default. */
  defaultPlaceholder?: string;
}

export function FieldControl({
  kind,
  info,
  name,
  id,
  labelId,
  value,
  onChange,
  rootSchema,
  required,
  allowUnset,
  canUnset,
  locked,
  invalid,
  describedBy,
  compact,
  issues,
  nullToggle,
  defaultPlaceholder,
}: FieldControlProps) {
  const isNull = value === null;
  switch (kind) {
    case "fixed":
      return (
        <p id={id} aria-labelledby={labelId} className="flex min-h-8 items-center gap-2 text-data text-fg-secondary">
          <code className="machine">{displayText(info.constValue)}</code>
          <Badge>{t("固定值")}</Badge>
        </p>
      );
    case "null-only":
      return (
        <div id={id} aria-labelledby={labelId} className="flex min-h-8 flex-wrap items-center gap-2 text-data text-fg-secondary">
          {value === undefined ? (
            <span className="text-fg-tertiary">{t("不指定")}</span>
          ) : (
            <code className={cn("machine", value === null ? "text-fg-secondary" : "text-danger")}>{previewValue(value, 40)}</code>
          )}
          <Badge title={t("provider 只接受 null：此設定由 provider 決定，不提供任意值")}>{t("只接受 null")}</Badge>
          {value !== null && (value !== undefined || required) && !locked ? (
            <Button size="sm" variant="quiet" onClick={() => { onChange(null); }}>
              {value === undefined ? t("設為 null") : t("改為 null")}
            </Button>
          ) : null}
        </div>
      );
    case "select": {
      const model = selectModel(info, value, { canUnset });
      return (
        <Select
          id={id}
          compact={compact}
          value={model.selected}
          disabled={locked}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const option = model.options.find((item) => item.key === event.target.value);
            if (!option || option.kind === "current") return;
            onChange(option.kind === "unset" ? undefined : option.value);
          }}
        >
          {model.options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </Select>
      );
    }
    case "switch":
      return (
        <Switch
          id={id}
          className={compact ? "min-h-8 py-1 text-data" : undefined}
          label={value === true ? t("true（啟用）") : t("false（停用）")}
          checked={value === true}
          disabled={locked}
          aria-describedby={describedBy}
          onChange={(event) => { onChange(event.target.checked); }}
        />
      );
    case "number":
      return (
        <NullableRow toggle={nullToggle}>
          <NumberControl
            id={id}
            value={isNull ? undefined : value}
            integer={info.kind === "integer"}
            emptyValue={allowUnset ? undefined : ""}
            onChange={onChange}
            disabled={locked || isNull}
            {...(describedBy === undefined ? {} : { describedBy })}
            invalid={invalid}
            {...optionalField("placeholder", isNull ? t("null（未設定）") : defaultPlaceholder)}
            compact={compact}
          />
        </NullableRow>
      );
    case "text":
      return (
        <NullableRow toggle={nullToggle}>
          <Input
            id={id}
            compact={compact}
            className="machine"
            value={typeof value === "string" ? value : value === undefined || value === null ? "" : displayText(value)}
            disabled={locked || isNull}
            placeholder={isNull ? t("null（未設定）") : defaultPlaceholder}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(raw === "" && allowUnset && !required ? undefined : raw);
            }}
          />
        </NullableRow>
      );
    case "list":
      return (
        <NullableRow toggle={nullToggle}>
          <ListControl
            id={id}
            value={isNull ? undefined : value}
            itemKind={scalarListItemKind(info, value, rootSchema) ?? "string"}
            onChange={onChange}
            disabled={locked || isNull}
            {...(describedBy === undefined ? {} : { describedBy })}
            invalid={invalid}
            {...(isNull ? { placeholder: t("null（未設定）") } : {})}
            compact={compact}
          />
        </NullableRow>
      );
    case "json":
    default:
      return isNull ? (
        <p id={id} aria-labelledby={labelId} className="flex min-h-10 items-center text-data text-fg-tertiary">
          null
        </p>
      ) : (
        <JsonEditor
          id={id}
          label={name}
          labelledBy={labelId}
          value={value ?? initialValueFor(info)}
          onChange={onChange}
          issues={issues}
          rows={info.kind === "array" ? 3 : 4}
          disabled={locked}
        />
      );
  }
}
