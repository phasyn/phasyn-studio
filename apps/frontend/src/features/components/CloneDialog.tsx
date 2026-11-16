import { Copy, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useProviders, type ComponentEntry, type NodeView } from "@/api/catalog";
import { usePutComponent } from "@/api/components";
import type { InstanceSettings } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { DiffTable } from "@/components/common/DiffTable";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { SchemaForm } from "@/components/common/SchemaForm";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { defaultFolderFor, folderSuggestions, parseFolderInput, folderDisplayPath } from "@/components/workbench/componentFolders";
import { diffDocuments } from "@/lib/diff";
import { cloneJson } from "@/lib/json";
import { ExclusiveGroupNote } from "./ExclusiveGroupNote";
import { FolderInput } from "./FolderInput";
import { cloneDefaults, componentIdError, DEVICE_FORM_ROOT, DEVICE_FORM_SCHEMA, deviceFormValue, instanceLabel, withDeviceForm } from "./instanceForms";
import { limitsBytes } from "./limitsModel";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";

function CloneForm({
  source,
  nodes,
  entries,
  onCreated,
  onCancel,
}: {
  source: ComponentEntry;
  nodes: readonly NodeView[];
  entries: readonly ComponentEntry[];
  onCreated: (nodeId: string, componentId: string) => void;
  onCancel: () => void;
}) {
  const sourceNode = source.node;
  const [targetId, setTargetId] = useState(sourceNode.node_id);
  const target = nodes.find((node) => node.node_id === targetId) ?? null;
  const taken = new Set(target?.snapshot?.components.map((component) => component.component_id) ?? []);
  const defaults = cloneDefaults(source, taken);
  const [componentId, setComponentId] = useState(defaults.componentId);
  const [label, setLabel] = useState(defaults.label);
  const [settings, setSettings] = useState<InstanceSettings>(() => cloneJson(source.descriptor.settings.stored));
  // 複製到同一個資料夾（沒有指定時＝同樣依 provider 預設分類）。
  const [folderText, setFolderText] = useState(source.descriptor.folder ?? "");
  const folder = parseFolderInput(folderText);
  const suggestions = folderSuggestions(entries.filter((entry) => entry.node.node_id === targetId).map((entry) => entry.descriptor));
  const providers = useProviders(target && !target.stale ? target.node_id : null);
  const put = usePutComponent();
  const idError = componentIdError(componentId, target);
  const providerInfo = providers.data?.items.find((item) => item.provider_id === source.descriptor.provider_id && item.runtime_id === source.descriptor.runtime_id) ?? null;
  // The copy keeps the source's exclusive group and limits: the Node reads both only from the definition.
  const group = source.descriptor.exclusive_group;
  const limits = source.descriptor.limits;
  const sourceDefinition = {
    node: sourceNode.label,
    component_id: source.descriptor.component_id,
    label: source.descriptor.label,
    provider_id: source.descriptor.provider_id,
    runtime_id: source.descriptor.runtime_id,
    settings: source.descriptor.settings.stored,
  };
  const cloneDefinition = { node: target?.label ?? targetId, component_id: componentId, label, provider_id: source.descriptor.provider_id, runtime_id: source.descriptor.runtime_id, settings };
  const changes = diffDocuments(sourceDefinition, cloneDefinition);
  const crossNode = targetId !== sourceNode.node_id;
  const blockReason = !target ? t("請選擇目標 Node") : target.stale ? t("目標 Node 離線") : (idError ?? (folder.error ? t("資料夾：{error}", { error: folder.error }) : null));

  const submit = () => {
    if (blockReason || put.isPending) return;
    put.mutate(
      {
        nodeId: targetId,
        definition: {
          component_id: componentId,
          label: instanceLabel(label, componentId),
          provider_id: source.descriptor.provider_id,
          runtime_id: source.descriptor.runtime_id,
          settings,
          autostart: false,
          folder: folder.value,
          ...(group ? { exclusive_group: group } : {}),
          ...(limits ? { limits: cloneJson(limits) } : {}),
        },
      },
      { onSuccess: () => onCreated(targetId, componentId) },
    );
  };

  return (
    <>
      <DialogBody className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="clone-node" label={t("目標 Node")}>
            {(describedBy) => (
              <Select id="clone-node" value={targetId} aria-describedby={describedBy} onChange={(event) => setTargetId(event.target.value)}>
                {nodes.map((node) => (
                  <option key={node.node_id} value={node.node_id} disabled={node.stale}>
                    {node.label}
                    {node.stale ? t("（離線，不可選）") : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="clone-id" label={t("新 component_id")} error={idError}>
            {(describedBy) => (
              <Input id="clone-id" className="machine" value={componentId} aria-describedby={describedBy} aria-invalid={Boolean(idError) || undefined} onChange={(event) => setComponentId(event.target.value)} />
            )}
          </Field>
          <Field id="clone-label" label={t("顯示名稱")}>
            {(describedBy) => <Input id="clone-label" value={label} aria-describedby={describedBy} onChange={(event) => setLabel(event.target.value)} />}
          </Field>
        </div>
        <Field
          id="clone-folder"
          label={t("資料夾")}
          error={folder.error}
          help={t("預設與來源相同；空白＝依 provider 預設分類（{provider_id}）。", { provider_id: folderDisplayPath(defaultFolderFor(source.descriptor.provider_id)) })}
        >
          {(describedBy) => (
            <FolderInput
              id="clone-folder"
              value={folderText}
              onChange={setFolderText}
              suggestions={suggestions}
              defaultFolder={defaultFolderFor(source.descriptor.provider_id)}
              invalid={folder.error !== null}
              describedBy={describedBy}
            />
          )}
        </Field>
        <ul className="grid gap-1 rounded-md border border-line-subtle bg-sunken px-3 py-2 text-caption text-fg-secondary" aria-label={t("沿用來源的設定")}>
          <li>
            {group ? (
              <T source={"互斥群組：<0>{group}</0>（沿用來源；同一台 Node 上同群組一次只能載入一個）"} values={{ group }} slots={[<code className="machine text-fg" />]} />
            ) : (
              t("互斥群組：無（來源沒有設定）")
            )}
          </li>
          <li>{limits ? t("使用上限（limits）：沿用來源（{bytes} bytes）", { bytes: limitsBytes(limits) }) : t("使用上限（limits）：無")}</li>
        </ul>
        <ExclusiveGroupNote nodeId={targetId} componentId={componentId} group={group} snapshot={target?.snapshot ?? null} />
        {source.descriptor.last_error?.code === "UNSUPPORTED_SETTING" ? (
          <Callout tone="warning" title={t("來源的設定不被 provider 接受")}>
            <p>{t("Node 會拒絕這份複製。請先在來源元件的檢視器修正定義（移除不認得的欄位、修改不支援的值），再複製。")}</p>
          </Callout>
        ) : null}
        {crossNode ? (
          <Callout tone="warning" title={t("跨 Node 複製：請確認 device 與本機路徑")}>
            <p>{t("device（{kind}:{id}，resource_group {resource_group}）與 model_path 來自原 Node，目標 Node 上可能不存在或代表不同硬體。", { kind: source.descriptor.device.kind, id: source.descriptor.device.id, resource_group: source.descriptor.device.resource_group })}</p>
          </Callout>
        ) : null}
        {target && !target.stale ? (
          providers.isPending ? (
            <p role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
              <LoaderCircle aria-hidden className="size-3.5 shrink-0 text-info animate-spin" />
              {t("檢查目標 Node 的 provider…")}
            </p>
          ) : providers.isError ? (
            <ErrorCallout error={providers.error} title={t("無法讀取目標 Node 的 provider 清單")} />
          ) : !providerInfo ? (
            <Callout tone="warning" title={t("目標 Node 沒有相同的 provider／runtime")}>
              <p>
                <T source={"找不到 <0>{provider_id}</0>（runtime {runtime_id}）；PUT 可能被拒絕（例如 PROVIDER_NOT_INSTALLED）。"} values={{ provider_id: source.descriptor.provider_id, runtime_id: source.descriptor.runtime_id }} slots={[<code className="machine" />]} />
              </p>
            </Callout>
          ) : !providerInfo.available ? (
            <Callout tone="warning" title={t("目標 Node 的 provider 不可用")}>
              <p>{tServer(providerInfo.reason) ?? t("未提供原因")}</p>
            </Callout>
          ) : null
        ) : null}
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-data font-semibold text-fg">{t("device 與模型路徑")}</legend>
          <SchemaForm
            schema={DEVICE_FORM_SCHEMA}
            rootSchema={DEVICE_FORM_ROOT}
            value={deviceFormValue(settings)}
            onChange={(next) => setSettings(withDeviceForm(settings, next))}
            idPrefix="clone-device"
            basePath="load"
            allowUnset
          />
        </fieldset>
        <section className="grid gap-2">
          <h3 className="text-data font-semibold text-fg">{t("與來源的差異（{changesCount}）", { changesCount: changes.length })}</h3>
          <DiffTable
            entries={changes}
            beforeLabel={t("來源 {component_id}", { component_id: source.descriptor.component_id })}
            afterLabel={t("新 instance")}
            label={t("複製差異")}
            highlight={(path) => (path.startsWith("settings.load.device") || path === "settings.load.model_path" ? t("device／路徑差異：請確認目標 Node 上確實存在") : null)}
          />
        </section>
        {put.isError ? <ErrorCallout error={put.error} write title={t("複製失敗；表單內容保留")} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<Copy aria-hidden />} pending={put.isPending} disabledReason={put.isPending ? null : blockReason} onClick={submit}>
          {t("建立複製")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/** 複製 instance：以既有定義（已保存設定＋provider／runtime）建立新 component_id，可選目標 Node。 */
export function CloneDialog({
  source,
  nodes,
  entries,
  onOpenChange,
  onCreated,
}: {
  source: ComponentEntry | null;
  nodes: readonly NodeView[];
  /** 目錄中的 instance（資料夾建議用）。 */
  entries: readonly ComponentEntry[];
  onOpenChange: (open: boolean) => void;
  onCreated: (nodeId: string, componentId: string) => void;
}) {
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("複製 instance")}</DialogTitle>
          <DialogDescription>
            <T source={"來源：{value}（{label}）。只建立定義，不會啟動。"} values={{ value: source?.descriptor.label || source?.descriptor.component_id, label: source?.node.label }} />
          </DialogDescription>
        </DialogHeader>
        {source ? <CloneForm source={source} nodes={nodes} entries={entries} onCreated={onCreated} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
