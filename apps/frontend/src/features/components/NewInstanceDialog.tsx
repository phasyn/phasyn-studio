import { Plus } from "lucide-react";
import { useState } from "react";
import { useProviders, type ComponentEntry, type NodeView } from "@/api/catalog";
import { usePutComponent } from "@/api/components";
import type { InstanceSettings } from "@/api/generated/contracts";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonEditor } from "@/components/common/JsonEditor";
import { SchemaForm } from "@/components/common/SchemaForm";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select, Switch } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { defaultFolderFor, folderDisplayPath, folderSuggestions, parseFolderInput } from "@/components/workbench/componentFolders";
import { Stepper, type StepperStep } from "@/components/workbench/Stepper";
import { CONTRACT_ROOT } from "@/lib/contractSchemas";
import { isRecord } from "@/lib/json";
import { validateValue } from "@/lib/schema";
import { exclusiveGroupError, groupsInUse, groupValue, suggestExclusiveGroup } from "./exclusiveGroup";
import { ExclusiveGroupNote } from "./ExclusiveGroupNote";
import { FolderInput } from "./FolderInput";
import { componentIdError, DEVICE_FORM_ROOT, DEVICE_FORM_SCHEMA, deviceFormValue, instanceLabel, settingsFromDefaults, withDeviceForm } from "./instanceForms";
import { tServer, t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { T } from "@/i18n/T";

const INSTANCE_SETTINGS = { $ref: "#/$defs/InstanceSettings" };

interface FormStep {
  id: string;
  label: string;
  done: boolean;
  error: boolean;
  detail: string | null;
}

/**
 * 表單進度（Node → provider → 識別 → 設定）：完全由表單目前的值推導，不另外保存步驟；
 * 第一個未完成（或有錯誤）的步驟是目前步驟，之後未完成的是尚未開始。
 */
function toStepperSteps(steps: readonly FormStep[]): StepperStep[] {
  let current = false;
  return steps.map((step) => {
    const base = { id: step.id, label: step.label, ...(step.detail ? { detail: step.detail } : {}) };
    if (step.error && !current) {
      current = true;
      return { ...base, state: "error" as const };
    }
    if (step.error) return { ...base, state: "error" as const };
    if (step.done) return { ...base, state: "done" as const };
    if (!current) {
      current = true;
      return { ...base, state: "active" as const };
    }
    return { ...base, state: "pending" as const };
  });
}

function NewInstanceForm({
  nodes,
  entries,
  initialNodeId,
  onCreated,
  onCancel,
}: {
  nodes: readonly NodeView[];
  entries: readonly ComponentEntry[];
  initialNodeId: string | null;
  onCreated: (nodeId: string, componentId: string) => void;
  onCancel: () => void;
}) {
  const selectable = nodes.filter((node) => !node.stale);
  const [nodeId, setNodeId] = useState<string>(initialNodeId && selectable.some((node) => node.node_id === initialNodeId) ? initialNodeId : (selectable[0]?.node_id ?? ""));
  const [providerKey, setProviderKey] = useState("");
  const [componentId, setComponentId] = useState("");
  const [label, setLabel] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [folderText, setFolderText] = useState("");
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  // null: follow the suggestion (it changes with the provider and the device); any text: what the user typed.
  const [groupText, setGroupText] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const providers = useProviders(nodeId || null);
  const put = usePutComponent();
  const node = nodes.find((item) => item.node_id === nodeId) ?? null;
  const items = providers.data?.items ?? [];
  // 測試／合成 provider（test.*）預設不列出：正式元件清單不需要它們，要做契約測試時再勾選顯示
  const isTestProvider = (item: (typeof items)[number]) => Boolean(item.synthetic) || item.provider_id.startsWith("test.");
  const hiddenTest = items.filter(isTestProvider).length;
  const listed = showTest ? items : items.filter((item) => !isTestProvider(item));
  const provider = items.find((item) => `${item.runtime_id}::${item.provider_id}` === providerKey) ?? null;
  const idError = componentIdError(componentId, node);
  const folder = parseFolderInput(folderText);
  const suggestions = folderSuggestions(entries.filter((entry) => entry.node.node_id === nodeId).map((entry) => entry.descriptor));
  const settingsIssues = settings ? validateValue(INSTANCE_SETTINGS, settings, CONTRACT_ROOT) : [];
  const members = node?.snapshot?.components ?? [];
  const suggestion = suggestExclusiveGroup(provider?.kind, settings?.load.device.resource_group, members, items);
  const groupInput = groupText ?? suggestion?.group ?? "";
  const groupError = exclusiveGroupError(groupInput);
  const group = groupError ? null : groupValue(groupInput);
  const blockReason = !node
    ? t("請選擇 Node")
    : !provider
      ? t("請選擇 provider")
      : !provider.available
        ? t("provider 不可用：{value}", { value: tServer(provider.reason) ?? t("未提供原因") })
        : idError
          ? idError
          : folder.error
            ? t("資料夾：{error}", { error: folder.error })
            : groupError
            ? t("互斥群組：{error}", { error: groupError })
            : !settings
            ? t("settings 尚未設定")
            : settingsIssues.length > 0
              ? t("settings 有 {settingsIssuesCount} 個問題", { settingsIssuesCount: settingsIssues.length })
              : null;

  const steps = toStepperSteps([
    {
      id: "node",
      label: "Node",
      done: node !== null && !node.stale,
      error: selectable.length === 0,
      detail: selectable.length === 0 ? t("沒有線上的 Node") : (node?.label ?? null),
    },
    {
      id: "provider",
      label: "provider",
      done: provider !== null && provider.available,
      error: (provider !== null && !provider.available) || providers.isError,
      detail: provider ? (provider.available ? provider.provider_id : t("不可用")) : providers.isError ? t("無法讀取清單") : null,
    },
    {
      id: "identity",
      label: t("識別與資料夾"),
      done: idError === null && folder.error === null && groupError === null,
      error: ((touched || componentId !== "") && (idError !== null || folder.error !== null)) || groupError !== null,
      detail: componentId || null,
    },
    {
      id: "settings",
      label: t("設定"),
      done: settings !== null && settingsIssues.length === 0,
      error: settings !== null && settingsIssues.length > 0,
      detail: settings !== null && settingsIssues.length > 0 ? t("{settingsIssuesCount} 個問題", { settingsIssuesCount: settingsIssues.length }) : null,
    },
  ]);

  const chooseProvider = (key: string) => {
    setProviderKey(key);
    setGroupText(null);
    const next = items.find((item) => `${item.runtime_id}::${item.provider_id}` === key) ?? null;
    setSettings(next ? settingsFromDefaults(next.default_settings) : null);
    if (next && !componentId) setComponentId(next.provider_id.replace(/[^A-Za-z0-9_.:-]+/g, "-"));
    if (next && !label) setLabel(next.label);
  };

  const submit = () => {
    setTouched(true);
    if (blockReason || !provider || !settings || put.isPending) return;
    put.mutate(
      {
        nodeId,
        // folder null＝依 provider 預設分類。
        definition: {
          component_id: componentId,
          label: instanceLabel(label, componentId),
          provider_id: provider.provider_id,
          runtime_id: provider.runtime_id,
          settings,
          autostart,
          folder: folder.value,
          // The Node reads the group only from the definition; no group → the key is left out.
          ...(group ? { exclusive_group: group } : {}),
        },
      },
      { onSuccess: () => onCreated(nodeId, componentId) },
    );
  };

  return (
    <>
      <DialogBody className="grid gap-4">
        {/* 包一層一般區塊：Stepper 是水平捲動容器，直接當 grid 項目時最小高度會被算成 0 而被壓扁。 */}
        <div className="pb-1">
          <Stepper steps={steps} label={t("新建 instance 的進度")} />
        </div>
        <Field id="new-node" label="Node" help={t("離線 Node 不可選（無法確認其 provider 與 runtime）。")}>
          {(describedBy) => (
            <Select
              id="new-node"
              value={nodeId}
              aria-describedby={describedBy}
              onChange={(event) => {
                setNodeId(event.target.value);
                setProviderKey("");
                setSettings(null);
                setGroupText(null);
              }}
            >
              {nodes.length === 0 ? <option value="">{t("目錄中沒有 Node")}</option> : null}
              {nodes.map((item) => (
                <option key={item.node_id} value={item.node_id} disabled={item.stale}>
                  {item.label}
                  {item.stale ? t("（離線，不可選）") : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="new-provider" label="provider" help={t("來自 Node 的 provider 清單；不可用者顯示原因（例如未安裝、缺權重）。")}>
          {(describedBy) => (
            <Select id="new-provider" value={providerKey} aria-describedby={describedBy} disabled={!nodeId || providers.isPending} onChange={(event) => chooseProvider(event.target.value)}>
              <option value="">{providers.isPending ? t("讀取 provider 清單…") : t("請選擇 provider")}</option>
              {listed.map((item) => (
                <option key={`${item.runtime_id}::${item.provider_id}`} value={`${item.runtime_id}::${item.provider_id}`} disabled={!item.available}>
                  {item.label} · {item.provider_id} · runtime {item.runtime_id} · {item.kind}
                  {item.synthetic ? t("（測試元件／合成示例）") : ""}
                  {!item.available ? t("（不可用：{value}）", { value: tServer(item.reason) ?? t("未提供原因") }) : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {hiddenTest > 0 ? (
          <label className="flex items-center gap-2 text-caption text-fg-tertiary">
            <input type="checkbox" checked={showTest} onChange={(event) => setShowTest(event.target.checked)} className="size-3.5" />
            {t("顯示測試用 provider（test.*，{hiddenTest} 個；只在做契約測試時需要）", { hiddenTest })}
          </label>
        ) : null}
        {providers.isError ? <ErrorCallout error={providers.error} title={t("無法讀取此 Node 的 provider 清單")} onRetry={() => void providers.refetch()} /> : null}
        {items.some((item) => !item.available) ? (
          <ul className="grid gap-1 rounded-md border border-line-subtle bg-sunken px-3 py-2 text-caption text-fg-tertiary">
            {items
              .filter((item) => !item.available)
              .map((item) => (
                <li key={`${item.runtime_id}::${item.provider_id}`}>
                  <T source={"<0>{provider_id}</0>（runtime {runtime_id}）不可用：{value}"} values={{ provider_id: item.provider_id, runtime_id: item.runtime_id, value: tServer(item.reason) ?? t("未提供原因") }} slots={[<code className="machine text-fg-secondary" />]} />
                </li>
              ))}
          </ul>
        ) : null}
        {provider?.synthetic ? <SyntheticBadge kind="test" /> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="new-component-id" label="component_id" error={touched || componentId ? idError : null} help={t("英數字與 _ . : -，以英數字開頭；同一 Node 內唯一。")}>
            {(describedBy) => (
              <Input
                id="new-component-id"
                className="machine"
                value={componentId}
                aria-describedby={describedBy}
                aria-invalid={Boolean(touched && idError) || undefined}
                onChange={(event) => setComponentId(event.target.value)}
              />
            )}
          </Field>
          <Field id="new-label" label={t("顯示名稱")}>
            {(describedBy) => <Input id="new-label" value={label} aria-describedby={describedBy} onChange={(event) => setLabel(event.target.value)} />}
          </Field>
        </div>
        <Field
          id="new-folder"
          label={t("資料夾")}
          error={folder.error}
          help={t("以「/」分層，最多 6 層，例如「生成/H3 DiT」；可選這個 Node 現有的資料夾或輸入新的。空白＝依 provider 預設分類{value}。", { value: provider ? t("（{provider_id}）", { provider_id: folderDisplayPath(defaultFolderFor(provider.provider_id)) }) : "" })}
        >
          {(describedBy) => (
            <FolderInput
              id="new-folder"
              value={folderText}
              onChange={setFolderText}
              suggestions={suggestions}
              defaultFolder={provider ? defaultFolderFor(provider.provider_id) : null}
              invalid={folder.error !== null}
              describedBy={describedBy}
            />
          )}
        </Field>
        <Field
          id="new-exclusive-group"
          label={t("互斥群組（exclusive_group）")}
          error={groupError}
          help={
            groupText === null && suggestion
              ? t("已依這個 Node 同一 resource_group 上同類 provider 的 {from} 預填。同一台 Node 上同群組的元件一次只能載入一個（例如 DiT 需要大量主記憶體），由 Node 在啟動時強制；建立後在元件頁只能檢視。", { from: formatList(suggestion.from) })
              : t("同一台 Node 上同群組的元件一次只能載入一個（例如 DiT 需要大量主記憶體），由 Node 在啟動時強制。空白＝不加入任何群組；建立後在元件頁只能檢視。")
          }
        >
          {(describedBy) => (
            <>
              <Input
                id="new-exclusive-group"
                className="machine"
                list="new-exclusive-group-options"
                value={groupInput}
                placeholder={t("空白＝不加入")}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={describedBy}
                aria-invalid={groupError ? true : undefined}
                onChange={(event) => setGroupText(event.target.value)}
              />
              <datalist id="new-exclusive-group-options">
                {groupsInUse(members).map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <ExclusiveGroupNote nodeId={nodeId} componentId={componentId} group={group} snapshot={node?.snapshot ?? null} />
        {settings ? (
          <>
            {!provider?.default_settings ? (
              <Callout tone="warning" title={t("provider 沒有提供預設設定")}>
                <p>{t("已填入最小骨架；請確認 device 與其他必要欄位。")}</p>
              </Callout>
            ) : null}
            <fieldset className="grid gap-3">
              <legend className="mb-1 text-data font-semibold text-fg">{t("device 與模型路徑（由 provider 預設帶入，可修改）")}</legend>
              <SchemaForm
                schema={DEVICE_FORM_SCHEMA}
                rootSchema={DEVICE_FORM_ROOT}
                value={deviceFormValue(settings)}
                onChange={(next) => setSettings(withDeviceForm(settings, next))}
                idPrefix="new-device"
                basePath="load"
                issues={settingsIssues}
                allowUnset
              />
            </fieldset>
            <JsonEditor
              id="new-settings-json"
              label={t("完整 settings（進階 JSON）")}
              value={settings}
              onChange={(next) => setSettings(next as InstanceSettings)}
              accept={(next) => (isRecord(next) && isRecord(next.load) && isRecord(next.invoke) && isRecord(next.recording) ? null : t("需要 load、invoke、recording 三個物件"))}
              issues={settingsIssues}
              rows={10}
              description={t("以契約 InstanceSettings 檢查；provider 專屬欄位由 Node 以其 schema 驗證。")}
            />
          </>
        ) : null}
        <Switch
          id="new-autostart"
          label={t("自動啟動：Node 服務啟動時自動載入這個元件")}
          description={t("只在 Node 服務啟動時處理一次；不是當機後自動重啟。預設關閉。")}
          checked={autostart}
          onChange={(event) => setAutostart(event.target.checked)}
        />
        {put.isError ? <ErrorCallout error={put.error} write title={t("建立失敗；表單內容保留")} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<Plus aria-hidden />} pending={put.isPending} disabledReason={put.isPending ? null : blockReason} onClick={submit}>
          {t("建立 instance")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/** 新建 instance：選 Node → provider（不可用者顯示原因）→ component_id／名稱／資料夾 → 由預設帶入的設定 → PUT。 */
export function NewInstanceDialog({
  open,
  onOpenChange,
  nodes,
  entries,
  initialNodeId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: readonly NodeView[];
  /** 目錄中的 instance（資料夾建議用）。 */
  entries: readonly ComponentEntry[];
  initialNodeId: string | null;
  onCreated: (nodeId: string, componentId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("新建 instance")}</DialogTitle>
          <DialogDescription>{t("只保存定義（PUT），不會自動啟動或下載任何模型；啟動請在元件頁按「啟動」。")}</DialogDescription>
        </DialogHeader>
        {open ? <NewInstanceForm nodes={nodes} entries={entries} initialNodeId={initialNodeId} onCreated={onCreated} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
