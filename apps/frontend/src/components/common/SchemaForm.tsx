// Forms generated from the JSON schemas providers declare (settings, call parameters, part overrides). SchemaForm lays
// out an object's fields and nested fieldsets; one field is SchemaField (schema-form/), its input FieldControl.
import { Trash } from "lucide-react";
import { use, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { domId } from "@/lib/dom";
import { withRecordValue, isRecord, joinPath, previewValue, type JsonObject } from "@/lib/json";
import { additionalPropertiesAllowed, describeField, hasDeclaredProperties, objectProperties, requiredKeys, schemaControl, type FieldInfo, type JsonSchema, type SchemaIssue } from "@/lib/schema";
import { HelpButton, HelpText } from "./HelpTip";
import { NullCheckbox } from "./schema-form/inputs";
import { LoraStackField } from "./schema-form/LoraStackField";
import { LORA_STACK_CONTROL } from "./schema-form/loraStackModel";
import { SchemaField, type FieldMeta } from "./schema-form/SchemaField";
import { useNullSwitch } from "./schema-form/useNullSwitch";
import { SchemaDensityContext } from "./schemaDensity";
import { t } from "@/i18n";

const EMPTY_ITEMS = [] as const;

export { SchemaField };
export type { FieldMeta, SchemaFieldProps } from "./schema-form/SchemaField";

export interface SchemaFormProps {
  schema: unknown;
  rootSchema?: JsonSchema;
  value: unknown;
  onChange: (next: JsonObject) => void;
  idPrefix: string;
  /** This object's path in the whole document (issues match full paths). */
  basePath?: string;
  issues?: readonly SchemaIssue[];
  disabled?: boolean;
  allowUnset?: boolean;
  /** Fields rendered elsewhere (for example part_overrides on the parts tab). */
  hiddenKeys?: readonly string[];
  emptyText?: string;
  depth?: number;
  /** Short names and help of the top-level fields, by key. */
  fieldMeta?: Readonly<Record<string, FieldMeta>>;
}



/**
 * An object with declared fields (possibly nullable): a fieldset with a nested form. When nullable, the legend has a
 * null switch, and switching back restores the previous content.
 */
function ObjectFieldset({
  name,
  path,
  schema,
  info,
  rootSchema,
  value,
  onChange,
  required,
  issues,
  disabled,
  allowUnset,
  idPrefix,
  depth,
  meta,
}: {
  name: string;
  path: string;
  schema: unknown;
  info: FieldInfo;
  rootSchema?: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  required: boolean;
  issues: readonly SchemaIssue[];
  disabled: boolean;
  allowUnset: boolean;
  idPrefix: string;
  depth: number;
  meta?: FieldMeta;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const setNull = useNullSwitch(value, onChange, () => ({}));
  const helpId = `${domId(idPrefix, path)}-help`;
  const help = [info.description, meta?.help].filter(Boolean).join(" · ");
  const isNull = value === null;
  const own = issues.filter((issue) => issue.path === path);
  const caption = meta?.caption ?? info.title;
  const compact = use(SchemaDensityContext) === "compact";
  return (
    <fieldset className={cn("grid min-w-0", compact ? "gap-1 pt-1" : "gap-3")} data-path={path} aria-describedby={help ? helpId : undefined}>
      <legend className={cn("flex flex-wrap items-center gap-2 text-data font-semibold text-fg", compact ? "mb-1" : "mb-2")}>
        <code className="machine">{name}</code>
        {(caption != null && caption !== "") ? <span className="font-normal text-fg-secondary">{caption}</span> : null}
        {required ? <Badge>{t("必填")}</Badge> : null}
        {help ? <HelpButton open={helpOpen} onToggle={() => { setHelpOpen((open) => !open); }} controls={helpId} label={name} text={help} /> : null}
        {info.nullable ? <NullCheckbox checked={isNull} onChange={setNull} name={name} disabled={disabled} /> : null}
      </legend>
      {help ? (
        <HelpText id={helpId} open={helpOpen} className="-mt-2">
          {help}
        </HelpText>
      ) : null}
      {own.length > 0 ? <p className="text-caption text-danger">{own.map((issue) => issue.message).join(t("；"))}</p> : null}
      {isNull ? (
        <p className="text-data text-fg-tertiary">{t("null（取消勾選 null 以編輯欄位）")}</p>
      ) : (
        <SchemaForm
          schema={schema}
          {...(rootSchema === undefined ? {} : { rootSchema })}
          value={value}
          onChange={onChange}
          idPrefix={idPrefix}
          basePath={path}
          issues={issues}
          disabled={disabled}
          allowUnset={allowUnset}
          depth={depth + 1}
          emptyText={t("provider 沒有宣告此物件的欄位。")}
        />
      )}
    </fieldset>
  );
}

/**
 * An object form generated from a JSON schema: nested objects (possibly nullable) are grouped in fieldsets, and existing
 * fields the schema does not describe are listed separately and can be removed.
 */
export function SchemaForm({
  schema,
  rootSchema,
  value,
  onChange,
  idPrefix,
  basePath = "",
  issues = EMPTY_ITEMS,
  disabled = false,
  allowUnset = false,
  hiddenKeys = EMPTY_ITEMS,
  emptyText,
  depth = 0,
  fieldMeta,
}: SchemaFormProps) {
  const compact = use(SchemaDensityContext) === "compact";
  const record = isRecord(value) ? value : {};
  const hidden = new Set(hiddenKeys);
  const properties = objectProperties(schema, rootSchema).filter(([key]) => !hidden.has(key));
  const declared = new Set(objectProperties(schema, rootSchema).map(([key]) => key));
  const required = requiredKeys(schema, rootSchema);
  const extras = Object.keys(record).filter((key) => record[key] !== undefined && !declared.has(key) && !hidden.has(key));
  const additionalAllowed = additionalPropertiesAllowed(schema, rootSchema);

  if (properties.length === 0 && extras.length === 0) {
    return <p className="text-data text-fg-tertiary">{emptyText ?? t("provider 沒有宣告此區的欄位。")}</p>;
  }

  return (
    <div className={cn("grid min-w-0", compact ? "gap-0.5" : "gap-4", depth > 0 && (compact ? "border-l border-line-subtle pl-3" : "border-l border-line-subtle pl-4"))}>
      {properties.map(([key, child]) => {
        const childInfo = describeField(child, rootSchema);
        const path = joinPath(basePath, key);
        const childValue = record[key];
        const meta = fieldMeta?.[key];
        const update = (next: unknown) => { onChange(withRecordValue(record, key, next)); };
        if (schemaControl(child, rootSchema) === LORA_STACK_CONTROL) {
          return (
            <LoraStackField
              key={key}
              name={key}
              path={path}
              idPrefix={idPrefix}
              parent={record}
              onParentChange={onChange}
              disabled={disabled}
              issues={issues}
              description={meta?.help}
            />
          );
        }
        if (childInfo.kind === "object" && hasDeclaredProperties(child, rootSchema) && depth < 6) {
          return (
            <ObjectFieldset
              key={key}
              name={key}
              path={path}
              schema={child}
              info={childInfo}
              {...(rootSchema === undefined ? {} : { rootSchema })}
              value={childValue}
              onChange={update}
              required={required.has(key)}
              issues={issues}
              disabled={disabled}
              allowUnset={allowUnset}
              idPrefix={idPrefix}
              depth={depth}
              {...(meta === undefined ? {} : { meta })}
            />
          );
        }
        return (
          <SchemaField
            key={key}
            name={key}
            path={path}
            idPrefix={idPrefix}
            schema={child}
            {...(rootSchema === undefined ? {} : { rootSchema })}
            value={childValue}
            onChange={update}
            required={required.has(key)}
            issues={issues}
            disabled={disabled}
            allowUnset={allowUnset}
            caption={meta?.caption}
            help={meta?.help}
            hint={meta?.hint}
            unsupported={meta?.unsupported ?? null}
          />
        );
      })}
      {extras.length > 0 ? (
        <div className="grid gap-2 rounded-md border border-warning/40 bg-sunken px-3 py-2">
          <p className="text-caption text-warning">
            {additionalAllowed
              ? t("以下欄位不在 provider schema 的欄位清單中（schema 允許額外欄位，但表單無法描述其型別）：")
              : t("以下欄位未在 provider schema 宣告：伺服器會以 422 拒絕，請移除或修正。")}
          </p>
          <ul className="grid gap-1">
            {extras.map((key) => (
              <li key={key} className="flex flex-wrap items-center gap-2 text-caption">
                <code className="machine text-fg">{joinPath(basePath, key)}</code>
                <span className="machine text-fg-tertiary">{previewValue(record[key], 80)}</span>
                {!disabled ? (
                  <Button size="sm" variant="quiet" icon={<Trash aria-hidden />} onClick={() => { onChange(withRecordValue(record, key, undefined)); }}>
                    {t("從草稿移除")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
