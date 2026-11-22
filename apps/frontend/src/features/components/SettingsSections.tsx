import { Ban, Gauge, Info } from "lucide-react";
import { Link } from "react-router";
import type { InstanceSettings, SettingsView } from "@/api/generated/contracts";
import { Disclosure } from "@/components/common/Disclosure";
import { JsonEditor } from "@/components/common/JsonEditor";
import { SchemaForm, type FieldMeta } from "@/components/common/SchemaForm";
import { matchesSetting, CONTRACT_ROOT } from "@/lib/contractSchemas";
import { isRecord, type JsonObject } from "@/lib/json";
import { describeField, objectProperties, propertySchema, type SchemaIssue } from "@/lib/schema";
import { PRECISION_FIELDS, precisionUnavailableReason, sectionSchemas, type SettingsRoot } from "./settingsModel";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

const SECTION_TEXT: Record<SettingsRoot, { title: string; effect: string }> = {
  load: { title: t("載入設定（load）"), effect: t("保存後若與目前載入不同會標示需 restart；不熱換進行中的模型。") },
  invoke: { title: t("呼叫預設（invoke）"), effect: t("下一次呼叫採用；不改變進行中的呼叫。") },
  recording: { title: t("錄製設定（recording）"), effect: t("下一個 recording 生效；進行中的呼叫保留原錄製設定。") },
};

function EffectNote({ root }: { root: SettingsRoot }) {
  return (
    <p className="flex items-start gap-2 text-caption text-fg-tertiary">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {SECTION_TEXT[root].effect}
    </p>
  );
}

const PRECISION_META: Record<string, FieldMeta> = Object.fromEntries(PRECISION_FIELDS.map((field) => [field.key, { caption: field.label, help: field.meaning }]));

/**
 * 精度欄位逐一獨立：provider schema 有宣告才可編輯（依 PRECISION_FIELDS 的順序），長說明收在（?）；
 * 沒有宣告的欄位集中在一個可展開清單並附原因，不佔滿表單。
 */
function PrecisionEditor({
  view,
  value,
  onChange,
  issues,
  idPrefix,
  disabled,
}: {
  view: Pick<SettingsView, "settings_schema">;
  value: unknown;
  onChange: (next: JsonObject) => void;
  issues: readonly SchemaIssue[];
  idPrefix: string;
  disabled: boolean;
}) {
  const section = sectionSchemas(view).load;
  const precisionSchema = section.fromProvider ? propertySchema(section.schema, "precision", section.root) : null;
  const record = isRecord(value) ? value : {};
  const hasPrecision = isRecord(precisionSchema) || precisionSchema === true;
  const declared = new Map(hasPrecision ? objectProperties(precisionSchema, section.root) : []);
  const known = new Set(PRECISION_FIELDS.map((field) => field.key));
  const available = PRECISION_FIELDS.filter((field) => declared.has(field.key));
  const unavailable = PRECISION_FIELDS.filter((field) => !declared.has(field.key));
  const extra = [...declared.keys()].filter((key) => !known.has(key));
  const info = hasPrecision ? describeField(precisionSchema, section.root) : null;
  const formSchema = {
    type: "object",
    properties: Object.fromEntries([...available.map((field) => field.key), ...extra].map((key) => [key, declared.get(key)])),
    required: info && Array.isArray(info.schema["required"]) ? info.schema["required"] : [],
    additionalProperties: info ? info.schema["additionalProperties"] !== false : true,
  };
  const meta: Record<string, FieldMeta> = { ...PRECISION_META, ...Object.fromEntries(extra.map((key) => [key, { help: t("provider 專屬的精度欄位") }])) };
  return (
    <fieldset className="grid min-w-0 gap-3" data-path="load.precision">
      <legend className="mb-1 flex flex-wrap items-center gap-2 text-data font-semibold text-fg">
        <code className="machine">precision</code>
        <span className="font-normal text-fg-secondary">{t("精度（各欄位獨立）")}</span>
      </legend>
      <p className="-mt-1 text-caption text-fg-tertiary">{t("要求值（requested）；實際採用與 runtime 觀測見「對照」頁籤。")}</p>
      {hasPrecision ? (
        <SchemaForm
          schema={formSchema}
          {...(section.root === undefined ? {} : { rootSchema: section.root })}
          value={record}
          onChange={onChange}
          idPrefix={idPrefix}
          basePath="load.precision"
          issues={issues}
          disabled={disabled}
          fieldMeta={meta}
          emptyText={t("provider 沒有宣告可設定的精度欄位。")}
        />
      ) : (
        <p className="text-caption text-fg-tertiary">
          <T source={"provider schema 沒有宣告 load.precision。{value}"} values={{ value: Object.keys(record).length > 0 ? (
            <span className="text-warning"> {t("草稿仍有 {record}：伺服器會以 422 拒絕，請在「進階」分頁的 JSON 中移除。", { record: formatList(Object.keys(record)) })}</span>
          ) : null }} />
        </p>
      )}
      {unavailable.length > 0 ? (
        <Disclosure
          summary={
            <span className="inline-flex items-center gap-1.5">
              <Ban aria-hidden className="size-3.5 text-fg-tertiary" />
              {t("{unavailableCount} 個精度欄位此 provider 不提供", { unavailableCount: unavailable.length })}
            </span>
          }
        >
          <ul className="grid gap-1.5 rounded-md border border-line-subtle bg-sunken/60 px-3 py-2">
            {unavailable.map((field) => (
              <li key={field.key} className="grid gap-0.5 text-caption" data-path={`load.precision.${field.key}`}>
                <span className="flex flex-wrap items-center gap-2">
                  <code className="machine text-fg-secondary">{field.key}</code>
                  <span className="text-fg-tertiary">{field.label}</span>
                </span>
                <span className="text-fg-tertiary">{precisionUnavailableReason(precisionSchema, section.root, field.key)}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </fieldset>
  );
}

/** 單一設定區（load／invoke／recording）的 schema 表單。 */
export function SettingsSection({
  root,
  view,
  draft,
  onChange,
  issues,
  disabled = false,
}: {
  root: SettingsRoot;
  view: Pick<SettingsView, "settings_schema">;
  draft: InstanceSettings;
  onChange: (next: InstanceSettings) => void;
  issues: readonly SchemaIssue[];
  disabled?: boolean;
}) {
  const section = sectionSchemas(view)[root];
  const idPrefix = `settings-${root}`;
  const setRoot = (next: JsonObject) => { onChange({ ...draft, [root]: next }); };
  return (
    <section className="grid min-w-0 gap-4" aria-label={SECTION_TEXT[root].title}>
      <EffectNote root={root} />
      {root === "recording" ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-tertiary">
          {section.fromProvider ? t("欄位依 provider schema。") : t("欄位依契約 RecorderConfig。")}
          <Link to="/records/tracking" className="inline-flex items-center gap-1">
            <Gauge aria-hidden className="size-3.5" />
            {t("在「追蹤設定」一次管理所有元件")}
          </Link>
        </p>
      ) : !section.fromProvider ? (
        <p className="text-caption text-fg-tertiary">
          {root === "load"
            ? t("provider 沒有宣告 load schema：表單依契約 LoadSettings，provider 專屬欄位請到「進階」分頁以 JSON 編輯。")
            : t("provider 沒有宣告呼叫預設欄位：可到「進階」分頁以 JSON 編輯，由伺服器檢查。")}
        </p>
      ) : null}
      {root === "load" ? (
        <PrecisionEditor
          view={view}
          value={draft.load.precision}
          onChange={(next) => { onChange({ ...draft, load: { ...draft.load, precision: next } }); }}
          issues={issues}
          idPrefix={idPrefix}
          disabled={disabled}
        />
      ) : null}
      <SchemaForm
        schema={section.schema}
        {...(section.root === undefined ? {} : { rootSchema: section.root })}
        value={draft[root]}
        onChange={setRoot}
        idPrefix={idPrefix}
        basePath={root}
        issues={issues}
        disabled={disabled}
        hiddenKeys={root === "load" ? ["precision", "part_overrides"] : []}
        {...(root === "invoke" ? { emptyText: t("provider 沒有宣告呼叫預設欄位。") } : {})}
      />
      {root === "load" ? <p className="text-caption text-fg-tertiary">{t("part_overrides 在「子部件」頁籤編輯。")}</p> : null}
    </section>
  );
}

/** 整份 settings 的進階 JSON：與表單是同一份草稿、同一份 schema。 */
export function SettingsJsonSection({
  view,
  draft,
  onChange,
  issues,
}: {
  view: Pick<SettingsView, "settings_schema">;
  draft: InstanceSettings;
  onChange: (next: InstanceSettings) => void;
  issues: readonly SchemaIssue[];
}) {
  return (
    <section className="grid min-w-0 gap-3" aria-label={t("進階 JSON")}>
      <p className="text-caption text-fg-tertiary">{t("整份 settings；語法正確即同步到表單草稿，儲存時只送出變更的欄位。")}</p>
      <JsonEditor
        id="settings-json"
        label="settings JSON"
        value={draft}
        accept={(next) =>
          matchesSetting("InstanceSettings", next) ? null : t("schema 不允許此值")
        }
        onChange={(next) => { if (matchesSetting("InstanceSettings", next)) onChange(next); }}
        issues={issues}
        rows={22}
        description={
          isRecord(view.settings_schema) && Object.keys(view.settings_schema).length > 0
            ? t("以 provider 的 settings_schema 檢查；object 合併、array 整體替換、null 是字面值。")
            : t("provider 沒有提供 settings_schema；以契約 InstanceSettings 檢查（{value}）。", { value: Object.keys(CONTRACT_ROOT).length > 0 ? t("已載入契約") : t("契約不可用") })
        }
      />
    </section>
  );
}
