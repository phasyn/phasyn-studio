// One schema field with its label, badges, actions (fill in the default, clear) and messages, in the regular layout or
// the inspector's compact property grid (SchemaDensityContext). The input itself is FieldControl.
import { Eraser, RotateCcw } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { domId } from "@/lib/dom";
import { displayText, valuesEqual } from "@/lib/json";
import { controlKind, describeField, initialNonNullValue, issuesUnder, rangeSummary, type JsonSchema, type SchemaIssue } from "@/lib/schema";
import { HelpButton, HelpText } from "../HelpTip";
import { SchemaDensityContext } from "../schemaDensity";
import { FieldControl } from "./FieldControl";
import { NullCheckbox, NullToggle } from "./inputs";
import { useNullSwitch } from "./useNullSwitch";
import { t } from "@/i18n";

export interface FieldMeta {
  /** A short display name beside the key. */
  caption?: string;
  /** Help folded behind the (?) button. */
  help?: string;
  /** A short hint that always shows (for example "≈ 64 MiB"). */
  hint?: ReactNode;
  /** A field the backend does not implement yet or keeps fixed: editing is disabled and the reason always shows. */
  unsupported?: { label: string; note: string } | null;
}

export interface SchemaFieldProps {
  /** The field name (the schema key, shown in mono). */
  name: string;
  /** The full path (for example load.precision.compute_dtype): matches issues and is shown. */
  path: string;
  idPrefix: string;
  schema: unknown;
  rootSchema?: JsonSchema;
  /** undefined = not set. */
  value: unknown;
  /** undefined removes the field (only offered with allowUnset). */
  onChange: (next: unknown) => void;
  required?: boolean;
  issues?: readonly SchemaIssue[];
  disabled?: boolean;
  /** The field may be cleared (the invoke default applies); a settings patch cannot delete fields, so settings forms do not offer it. */
  allowUnset?: boolean;
  label?: ReactNode;
  /** A short display name beside the key (default: the schema title). */
  caption?: ReactNode;
  /** Help folded behind (?), joined with the schema description. */
  help?: ReactNode;
  /** A short hint that always shows. */
  hint?: ReactNode;
  /** A field the backend does not implement yet or keeps fixed: editing is disabled and the reason always shows. */
  unsupported?: { label: string; note: string } | null;
}

/**
 * One schema field: enum → select (with "not set (null)" when nullable), boolean → switch or three-way select, numbers
 * and strings (with a null switch beside them when nullable), scalar arrays → a comma list, null-only or fixed values →
 * read-only; only genuinely complex shapes use JSON. Long help folds behind (?).
 */
export function SchemaField({
  name,
  path,
  idPrefix,
  schema,
  rootSchema,
  value,
  onChange,
  required = false,
  issues = [],
  disabled = false,
  allowUnset = false,
  label,
  caption,
  help,
  hint,
  unsupported = null,
}: SchemaFieldProps) {
  const compact = useContext(SchemaDensityContext) === "compact";
  const info = describeField(schema, rootSchema);
  const id = domId(idPrefix, path);
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const helpId = `${id}-help`;
  const unsupportedId = `${id}-unsupported`;
  const [helpOpen, setHelpOpen] = useState(false);
  const setNull = useNullSwitch(value, onChange, () => initialNonNullValue(info));
  const own = issues.filter((issue) => issue.path === path);
  const nested = issuesUnder(issues, path).filter((issue) => issue.path !== path);
  const kind = controlKind(info, { required, allowUnset, value }, rootSchema);
  // A comma list has no input per item: item-level issues (such as trace_steps[2]) show under this field too.
  const shownIssues = kind === "list" ? [...own, ...nested] : own;
  const invalid = shownIssues.length > 0;
  const locked = disabled || info.readOnly || unsupported !== null;
  const isNull = value === null;
  const range = rangeSummary(info);
  const hasHint = Boolean(range || hint);
  const hasHelp = Boolean(info.description || help);
  const helpTitle = [info.description, typeof help === "string" ? help : null].filter(Boolean).join(" · ") || undefined;
  const describedBy =
    [invalid ? errorId : null, unsupported ? unsupportedId : null, hasHint ? hintId : null, hasHelp ? helpId : null].filter(Boolean).join(" ") || undefined;
  const canUnset = allowUnset && !required && value !== undefined;
  const defaultDiffers = info.hasDefault && !valuesEqual(value, info.defaultValue);
  const inlineNull = info.nullable && (kind === "number" || kind === "text" || kind === "list");
  const headerNull = info.nullable && kind === "json";

  const control = (
    <FieldControl
      kind={kind}
      info={info}
      name={name}
      id={id}
      labelId={labelId}
      value={value}
      onChange={onChange}
      rootSchema={rootSchema}
      required={required}
      allowUnset={allowUnset}
      canUnset={canUnset}
      locked={locked}
      invalid={invalid}
      describedBy={describedBy}
      compact={compact}
      issues={[...own, ...nested]}
      nullToggle={inlineNull ? <NullToggle checked={isNull} onChange={setNull} name={name} disabled={locked} compact={compact} /> : null}
      defaultPlaceholder={value === undefined && info.hasDefault ? t("預設 {defaultValue}", { defaultValue: displayText(info.defaultValue) }) : undefined}
    />
  );
  const spanLabel = kind === "switch" || kind === "json" || kind === "fixed" || kind === "null-only";
  const captionText = caption ?? info.title;
  const nullCheckbox = headerNull ? <NullCheckbox checked={isNull} onChange={setNull} name={name} disabled={locked} /> : null;
  const helpButton = hasHelp ? <HelpButton open={helpOpen} onToggle={() => setHelpOpen((open) => !open)} controls={helpId} label={name} text={helpTitle} /> : null;
  const badges =
    required || info.readOnly || unsupported ? (
      <>
        {required ? <Badge>{t("必填")}</Badge> : null}
        {info.readOnly ? <Badge>{t("唯讀")}</Badge> : null}
        {unsupported ? <Badge tone="warning">{unsupported.label}</Badge> : null}
      </>
    ) : null;
  const messages = (
    <>
      {unsupported ? (
        <p id={unsupportedId} className="text-caption text-warning">
          {unsupported.note}
        </p>
      ) : null}
      {invalid ? (
        <p id={errorId} className="text-caption text-danger">
          {shownIssues.map((issue) => (issue.path === path ? issue.message : t("{path}：{message}", { path: issue.path.slice(path.length), message: issue.message }))).join(t("；"))}
        </p>
      ) : null}
      {hasHint ? (
        <p id={hintId} className="text-caption text-fg-tertiary">
          {range}
          {range && hint ? " · " : null}
          {hint}
        </p>
      ) : null}
      {hasHelp ? (
        <HelpText id={helpId} open={helpOpen}>
          {info.description}
          {info.description && help ? " · " : null}
          {help}
        </HelpText>
      ) : null}
    </>
  );

  if (compact) {
    // The inspector's property grid: label column (display name, mono key below) | value column (control and icon
    // actions, messages below).
    const text = label ?? (captionText ? <span>{captionText}</span> : <code className="machine">{name}</code>);
    return (
      <div className="grid min-w-0 grid-cols-[minmax(6.5rem,7.5rem)_minmax(0,1fr)] items-start gap-x-3 py-0.5" data-path={path}>
        <div className="flex min-h-8 min-w-0 flex-col justify-center py-0.5" title={path}>
          {spanLabel ? (
            <span id={labelId} className="text-data [overflow-wrap:anywhere] text-fg-secondary">
              {text}
            </span>
          ) : (
            <label id={labelId} htmlFor={id} className="text-data [overflow-wrap:anywhere] text-fg-secondary">
              {text}
            </label>
          )}
          {captionText && !label ? <code className="machine truncate text-[11px] leading-4 text-fg-tertiary">{name}</code> : null}
        </div>
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 items-center gap-0.5">
            <div className="min-w-0 flex-1">{control}</div>
            {nullCheckbox}
            {helpButton}
            {defaultDiffers && !locked ? (
              <Button
                size="icon-sm"
                variant="quiet"
                icon={<RotateCcw aria-hidden />}
                onClick={() => onChange(info.defaultValue)}
                aria-label={t("{name} 填入 provider 預設值 {defaultValue}", { name, defaultValue: displayText(info.defaultValue) })}
                title={t("填入 provider 預設：{defaultValue}", { defaultValue: displayText(info.defaultValue) })}
              />
            ) : null}
            {canUnset && !locked ? (
              <Button size="icon-sm" variant="quiet" icon={<Eraser aria-hidden />} onClick={() => onChange(undefined)} aria-label={t("清除 {name}", { name })} title={t("清除 {name}", { name })} />
            ) : null}
          </div>
          {badges ? <div className="flex flex-wrap items-center gap-1">{badges}</div> : null}
          {messages}
        </div>
      </div>
    );
  }

  const labelContent = (
    <>
      {label ?? <code className="machine text-fg">{name}</code>}
      {captionText ? <span className="ml-2 font-normal">{captionText}</span> : null}
    </>
  );
  return (
    <div className="grid min-w-0 content-start gap-1.5" data-path={path}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
        {spanLabel ? (
          <span id={labelId} className="text-data font-medium text-fg-secondary">
            {labelContent}
          </span>
        ) : (
          <label id={labelId} htmlFor={id} className="text-data font-medium text-fg-secondary">
            {labelContent}
          </label>
        )}
        {badges}
        {helpButton}
        {nullCheckbox}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {defaultDiffers && !locked ? (
            <Button
              size="sm"
              variant="quiet"
              icon={<RotateCcw aria-hidden />}
              onClick={() => onChange(info.defaultValue)}
              aria-label={t("{name} 填入 provider 預設值 {defaultValue}", { name, defaultValue: displayText(info.defaultValue) })}
              title={t("provider 預設：{defaultValue}", { defaultValue: displayText(info.defaultValue) })}
            >
              {t("填入預設")}
            </Button>
          ) : null}
          {canUnset && !locked ? (
            <Button size="sm" variant="quiet" icon={<Eraser aria-hidden />} onClick={() => onChange(undefined)} aria-label={t("清除 {name}", { name })}>
              {t("清除")}
            </Button>
          ) : null}
        </span>
      </div>
      {control}
      {messages}
    </div>
  );
}
