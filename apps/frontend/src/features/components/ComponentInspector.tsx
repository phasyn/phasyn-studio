import { matchesSetting } from "@/lib/contractSchemas";
import { BookmarkPlus, ClipboardPaste, Code2, Copy, Cpu, Gauge, HardDriveDownload, Layers, LoaderCircle, RotateCw, Save, ScrollText, SlidersHorizontal, Trash2, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { ComponentEntry } from "@/api/catalog";
import { useProviders } from "@/api/catalog";
import { fetchSettings, useComponentSettings, useControlComponent, usePatchSettings } from "@/api/components";
import type { InstanceSettings, SettingsView } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Disclosure } from "@/components/common/Disclosure";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { SchemaDensityContext } from "@/components/common/schemaDensity";
import { LoraCatalogContext } from "@/components/common/schema-form/loraCatalogContext";
import { parseCatalog } from "@/components/common/schema-form/loraStackModel";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { IdText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { ToolButton, ToolStrip } from "@/components/workbench/ToolStrip";
import { diffDocuments } from "@/lib/diff";
import { hasErrorCode } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { applyMergePatch } from "@/lib/merge";
import type { SchemaIssue } from "@/lib/schema";
import { CompareTab } from "./CompareTab";
import { ComponentMetaSection } from "./ComponentMetaSection";
import { deleteBlockReason, type MetaDraft } from "./componentsModel";
import { ConflictDialog, type ConflictState } from "./ConflictDialog";
import { ControlBar } from "./ControlBar";
import { DefinitionRepair } from "./DefinitionRepair";
import { DefinitionSection } from "./DefinitionSection";
import { DeleteInstanceDialog } from "./DeleteInstanceDialog";
import { PartsTab } from "./PartsTab";
import { PortList } from "./PortList";
import { SettingsJsonSection, SettingsSection } from "./SettingsSections";
import { settingsIssues, settingsPatch } from "./settingsModel";
import { WeightsDialog } from "./WeightsDialog";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

export interface DraftEntry {
  /** 草稿開始編輯時的伺服器設定（儲存時 expected_revision 用這份）。 */
  base: SettingsView;
  draft: InstanceSettings;
}

type TabId = "props" | "parts" | "inputs" | "outputs" | "compare" | "advanced";
type SectionId = "basic" | "load" | "invoke" | "recording";

const SECTIONS: readonly { id: Exclude<SectionId, "basic">; title: string; icon: typeof Cpu }[] = [
  { id: "load", title: t("載入（load）"), icon: Cpu },
  { id: "invoke", title: t("呼叫預設（invoke）"), icon: SlidersHorizontal },
  { id: "recording", title: t("錄製（recording）"), icon: Gauge },
];

function locate(path: string): { tab: TabId; section: SectionId | null } {
  if (path.startsWith("load.part_overrides")) return { tab: "parts", section: null };
  if (path.startsWith("load")) return { tab: "props", section: "load" };
  if (path.startsWith("invoke")) return { tab: "props", section: "invoke" };
  if (path.startsWith("recording")) return { tab: "props", section: "recording" };
  return { tab: "advanced", section: null };
}

function RestartNow({ entry }: { entry: ComponentEntry }) {
  const control = useControlComponent(entry.node.node_id, entry.descriptor.component_id);
  const state = entry.descriptor.state;
  const reason = entry.node.stale
    ? t("Node 離線或狀態過時")
    : state === "busy"
      ? t("請先取消進行中的呼叫")
      : state === "loading" || state === "stopping"
        ? t("狀態變化中，請等待")
        : null;
  return (
    <div className="grid gap-2">
      <ActionButton size="sm" icon={<RotateCw aria-hidden />} pending={control.isPending} disabledReason={reason} onClick={() => { control.mutate({ action: "restart" }); }}>
        {t("立即重新載入（restart）")}
      </ActionButton>
      {control.isSuccess ? (
        <p className="text-caption text-fg-secondary animate-rise-in">{t("已送出 restart：狀態 {state}；載入完成後 loaded revision 才會更新。", { state: control.data.state })}</p>
      ) : null}
      {control.isError ? <ErrorCallout error={control.error} write title={t("restart 未完成")} /> : null}
    </div>
  );
}

function IssueList({ issues, onJump }: { issues: readonly SchemaIssue[]; onJump: (issue: SchemaIssue) => void }) {
  return (
    <ul className="grid max-h-40 gap-1 overflow-y-auto">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${String(index)}`} className="text-caption text-fg-secondary">
          <T source={"{button}：{message}"} values={{ button: <button type="button" className="text-left text-action-fg underline underline-offset-2 hover:text-action-hover" onClick={() => { onJump(issue); }}>
            <span className="machine">{issue.path || t("（根）")}</span>
          </button>, message: issue.message }} />
        </li>
      ))}
    </ul>
  );
}

/** 右側檢視器：基本資料（名稱、資料夾、自動啟動）、設定草稿（schema 表單＋進階 JSON）、子部件、三欄對照、控制、儲存與刪除。 */
export function ComponentInspector({
  entry,
  draftEntry,
  onDraftEntryChange,
  metaDraft,
  onMetaDraftChange,
  folderSuggestions,
  onClone,
  onSavePreset,
  onApplyPreset,
  onDeleted,
}: {
  entry: ComponentEntry;
  draftEntry: DraftEntry | null;
  onDraftEntryChange: (next: DraftEntry | null) => void;
  metaDraft: MetaDraft | null;
  onMetaDraftChange: (next: MetaDraft | null) => void;
  /** 這個 Node 現有的資料夾（輸入建議）。 */
  folderSuggestions: readonly string[];
  onClone: () => void;
  onSavePreset: (settings: InstanceSettings) => void;
  onApplyPreset: (base: SettingsView, draft: InstanceSettings) => void;
  onDeleted: (nodeId: string, componentId: string) => void;
}) {
  const { descriptor, node } = entry;
  const nodeId = node.node_id;
  const componentId = descriptor.component_id;
  const settingsQuery = useComponentSettings(nodeId, componentId);
  const providers = useProviders(node.stale ? null : nodeId);
  const patch = usePatchSettings(nodeId, componentId);
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("props");
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({ basic: true, load: true, invoke: true, recording: true });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [conflictError, setConflictError] = useState<unknown>(null);

  const serverView: SettingsView = settingsQuery.data ?? descriptor.settings;
  const base = draftEntry?.base ?? serverView;
  const draft = draftEntry?.draft ?? serverView.stored;
  const changes = diffDocuments(base.stored, draft);
  const dirty = changes.length > 0;
  const issues = settingsIssues(base, descriptor.parts, draft);
  const plan = settingsPatch(base.stored, draft);
  const baseOutdated = serverView.stored_revision > base.stored_revision;
  const providerInfo = providers.data?.items.find((item) => item.provider_id === descriptor.provider_id && item.runtime_id === descriptor.runtime_id);
  const synthetic = providerInfo?.synthetic === true || descriptor.provider_id.startsWith("test.");
  const saving = patch.isPending;
  const draftOptions = isRecord(draft.load.provider_options) ? draft.load.provider_options : {};
  const draftVariant = typeof draftOptions["variant"] === "string" ? draftOptions["variant"] : null;
  const facts = descriptor.facts;
  const loraCatalog = useMemo(() => ({ entries: parseCatalog(facts), variant: draftVariant }), [facts, draftVariant]);

  const setDraft = (next: InstanceSettings) => {
    setSaved(null);
    onDraftEntryChange({ base, draft: next });
  };

  const jumpTo = (issue: SchemaIssue) => {
    const target = locate(issue.path);
    setTab(target.tab);
    const section = target.section;
    if (section) setOpenSections((current) => ({ ...current, [section]: true }));
    window.requestAnimationFrame(() => {
      const scope = document.querySelector(`[data-path="${CSS.escape(issue.path)}"]`);
      const target = scope?.querySelector<HTMLElement>("input, select, textarea, button") ?? null;
      target?.focus();
    });
  };

  const saveReason = !dirty
    ? t("沒有變更")
    : !plan.patch
      ? t("變更無法以 patch 表達（只有移除欄位）")
      : issues.length > 0
        ? t("有 {issuesCount} 個問題需先修正", { issuesCount: issues.length })
        : node.stale
          ? t("Node 離線：無法保存到 Node")
          : null;

  const save = () => {
    if ((saveReason ?? "") || !plan.patch || saving) return;
    const baseAtSave = base;
    const mine = draft;
    setSaved(null);
    setConflictError(null);
    patch.mutate(
      { expected_revision: baseAtSave.stored_revision, patch: plan.patch },
      {
        onSuccess: (view) => {
          onDraftEntryChange(null);
          setSaved(view);
        },
        onError: (error) => {
          if (!hasErrorCode(error, "REVISION_CONFLICT")) return;
          fetchSettings(nodeId, componentId)
            .then((latest) => { setConflict({ base: baseAtSave, latest, mine }); })
            .catch((cause: unknown) => { setConflictError(cause); });
        },
      },
    );
  };

  const rebaseOnto = (latest: SettingsView, mine: InstanceSettings, from: SettingsView) => {
    const myPatch = settingsPatch(from.stored, mine).patch;
    const merged = myPatch ? applyMergePatch(latest.stored, myPatch) : latest.stored;
    if (!matchesSetting("InstanceSettings", merged)) {
      setConflictError(new Error(t("schema 不允許此值")));
      return false;
    }
    onDraftEntryChange({ base: latest, draft: merged });
    return true;
  };

  const kind = providerKind(descriptor.provider_id);
  const deleteReason = deleteBlockReason(entry);
  const tabs = [
    { id: "props", label: t("屬性") },
    { id: "parts", label: t("子部件"), count: descriptor.parts.length },
    { id: "inputs", label: t("輸入"), count: descriptor.inputs.length },
    { id: "outputs", label: t("輸出"), count: descriptor.outputs.length },
    { id: "compare", label: t("對照") },
    { id: "advanced", label: t("進階") },
  ] as const;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={kind.icon}
        {...(kind.art === undefined ? {} : { art: kind.art })}
        tone={kind.tone}
        title={descriptor.label || componentId}
        status={<StatusBadge kind="component" value={descriptor.state} />}
        description={
          <span className="grid gap-1">
            <span>
              {kind.label} · <code className="machine">{descriptor.provider_id}</code> · {node.label}
            </span>
            {serverView.restart_required || node.stale || synthetic || (descriptor.active_call_id != null && descriptor.active_call_id !== "") ? (
              <span className="flex flex-wrap items-center gap-1">
                {serverView.restart_required ? (
                  <Badge tone="warning" title={t("已保存的 load 設定與目前載入不同")}>
                    {t("需 restart")}
                  </Badge>
                ) : null}
                {node.stale ? <Badge tone="warning">{t("Node 過時")}</Badge> : null}
                {synthetic ? <SyntheticBadge kind="test" /> : null}
                {(descriptor.active_call_id != null && descriptor.active_call_id !== "") ? (
                  <span className="inline-flex items-center gap-1 text-fg-tertiary">
                    {t("呼叫中")} <IdText value={descriptor.active_call_id} length={12} />
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        }
        id={componentId}
        actions={<ControlBar entry={entry} />}
      />
      <ToolStrip label={t("元件動作")} className="min-h-9 gap-x-0.5 px-1.5">
        <ToolButton label={t("複製 instance")} text={t("複製", undefined, { context: "duplicate" })} icon={<Copy aria-hidden />} onClick={onClone} />
        <ToolButton label={t("把已保存設定存為 preset")} text={t("存為 preset")} icon={<BookmarkPlus aria-hidden />} onClick={() => { onSavePreset(serverView.stored); }} />
        <ToolButton label={t("套用 preset 到草稿")} text={t("套用 preset")} icon={<ClipboardPaste aria-hidden />} onClick={() => { onApplyPreset(base, draft); }} />
        <ToolButton
          label={t("查看這個元件的效能紀錄")}
          text={t("紀錄")}
          icon={<ScrollText aria-hidden />}
          onClick={() => void navigate(`/records/recordings?component_id=${encodeURIComponent(componentId)}&node_id=${encodeURIComponent(nodeId)}`)}
        />
        <ToolButton
          label={t("模型權重：檢查這個元件需要的固定版本權重，同意授權後下載")}
          text={t("模型權重…")}
          icon={<HardDriveDownload aria-hidden />}
          onClick={() => { setWeightsOpen(true); }}
        />
        <ToolButton
          label={t("刪除 instance")}
          text={t("刪除 instance…")}
          icon={<Trash2 aria-hidden />}
          disabledReason={deleteReason}
          onClick={() => { setDeleteOpen(true); }}
          className="ml-auto text-danger hover:text-danger"
        />
      </ToolStrip>
      {settingsQuery.isError ? (
        <Callout tone="warning" title={t("無法從 Node 讀取最新設定：顯示目錄快照（可能過時）")} className="m-2">
          <p className="machine text-caption">{settingsQuery.error instanceof Error ? tServer(settingsQuery.error.message) : ""}</p>
          <Button size="sm" onClick={() => void settingsQuery.refetch()} pending={settingsQuery.isFetching}>
            {t("重新讀取設定")}
          </Button>
        </Callout>
      ) : settingsQuery.isPending ? (
        <p className="flex items-center gap-1.5 px-3 py-1.5 text-caption text-fg-tertiary" role="status">
          <LoaderCircle aria-hidden className="size-3.5 shrink-0 text-info animate-spin" />
          {t("正在從 Node 讀取設定；暫時顯示目錄快照。")}
        </p>
      ) : null}

      <DefinitionRepair entry={entry} draft={draft} draftChanged={dirty} onJump={(path) => { jumpTo({ path, message: "" }); }} onReplaced={() => { onDraftEntryChange(null); }} />
      {descriptor.last_error?.code === "COMPONENT_NOT_CONFIGURED" ? (
        <Callout tone="warning" title={t("元件缺少設定或檔案")} className="m-2">
          <p className="text-caption">{t("如果缺的是模型權重，可以檢查這個元件需要哪些固定版本的檔案，同意授權後由 Node 下載到設定的模型目錄。")}</p>
          <Button size="sm" icon={<HardDriveDownload aria-hidden />} onClick={() => { setWeightsOpen(true); }}>
            {t("檢查模型權重…")}
          </Button>
        </Callout>
      ) : null}

      <PanelTabs tabs={tabs} value={tab} onChange={setTab} idPrefix="component-inspector" label={t("元件屬性分頁")} variant="underline" />
      <DockBody role="tabpanel" id={`component-inspector-panel-${tab}`} aria-labelledby={`component-inspector-tab-${tab}`}>
        {tab === "props" ? (
          <LoraCatalogContext value={loraCatalog}>
          <SchemaDensityContext value="compact">
            <ComponentMetaSection
              entry={entry}
              draft={metaDraft}
              onDraftChange={onMetaDraftChange}
              suggestions={folderSuggestions}
              open={openSections.basic}
              onOpenChange={(open) => { setOpenSections((current) => ({ ...current, basic: open })); }}
            />
            {SECTIONS.map((section) => (
              <PropertySection
                key={section.id}
                title={section.title}
                icon={<section.icon aria-hidden />}
                open={openSections[section.id]}
                onOpenChange={(open) => { setOpenSections((current) => ({ ...current, [section.id]: open })); }}
              >
                <SettingsSection root={section.id} view={base} draft={draft} onChange={setDraft} issues={issues} disabled={saving} />
              </PropertySection>
            ))}
          </SchemaDensityContext>
          </LoraCatalogContext>
        ) : tab === "parts" ? (
          <div className="p-3">
            <PartsTab parts={descriptor.parts} draft={draft} onChange={setDraft} issues={issues} disabled={saving} />
          </div>
        ) : tab === "inputs" ? (
          <PortList ports={descriptor.inputs} direction="input" />
        ) : tab === "outputs" ? (
          <PortList ports={descriptor.outputs} direction="output" />
        ) : tab === "compare" ? (
          <div className="p-3">
            <CompareTab view={serverView} nodeId={nodeId} componentId={componentId} />
          </div>
        ) : (
          <>
            <PropertySection title={t("整份設定 JSON")} icon={<Code2 aria-hidden />}>
              <SettingsJsonSection view={base} draft={draft} onChange={setDraft} issues={issues} />
            </PropertySection>
            <PropertySection title={t("元件定義")} icon={<Layers aria-hidden />} defaultOpen={false}>
              <DefinitionSection descriptor={descriptor} />
            </PropertySection>
          </>
        )}
      </DockBody>

      <InspectorFooter
        note={
          <span aria-live="polite">
            {dirty ? t("{changesCount} 個欄位已修改（基於 revision #{stored_revision}）", { changesCount: changes.length, stored_revision: base.stored_revision }) : t("與已保存 revision #{stored_revision} 一致", { stored_revision: serverView.stored_revision })}
          </span>
        }
      >
        <div className="grid w-full gap-2">
          {baseOutdated && dirty ? (
            <Callout tone="warning" title={t("伺服器已有 revision #{stored_revision}（草稿基於 #{stored_revision2}）", { stored_revision: serverView.stored_revision, stored_revision2: base.stored_revision })}>
              <p>{t("儲存時會以 expected_revision 檢查並回報衝突；也可以先把你的修改重新套用到最新版。")}</p>
              <Button size="sm" onClick={() => { rebaseOnto(serverView, draft, base); }}>
                {t("以最新版為基礎重新套用")}
              </Button>
            </Callout>
          ) : null}
          {dirty && issues.length > 0 ? (
            <Disclosure summary={<span className="text-danger">{t("{issuesCount} 個問題阻擋儲存（伺服器會以 422 拒絕）", { issuesCount: issues.length })}</span>} defaultOpen={issues.length <= 3}>
              <IssueList issues={issues} onJump={jumpTo} />
            </Disclosure>
          ) : null}
          {plan.removedPaths.length > 0 ? (
            <p className="text-caption text-warning">
              {t("草稿移除了 {removedPaths}：PATCH 不會刪除欄位（伺服器保留原值）；要還原預設請填入 provider 預設值。", { removedPaths: formatList(plan.removedPaths) })}
            </p>
          ) : null}
          {descriptor.state === "busy" && dirty ? (
            <p className="text-caption text-fg-secondary">{t("元件呼叫中：可以儲存，進行中的呼叫保留自己的設定快照，下次呼叫／載入才採用。")}</p>
          ) : null}
          {saved && !dirty ? (
            saved.restart_required ? (
              <Callout tone="warning" title={t("已儲存，尚未重新載入")} className="animate-rise-in">
                <p>
                  {t("已保存 revision #{stored_revision}；目前載入的仍是 {value}。load 設定要明確 restart 才會生效；invoke／recording 於下一次呼叫生效。", { stored_revision: saved.stored_revision, value: saved.loaded_revision === null ? t("（無）") : `#${String(saved.loaded_revision)}` })}
                </p>
                <RestartNow entry={entry} />
              </Callout>
            ) : (
              <Callout tone="success" title={t("已儲存（revision #{stored_revision}）", { stored_revision: saved.stored_revision })} className="animate-rise-in">
                <p>
                  {saved.loaded_revision === null
                    ? t("元件目前未載入：下次 start 時採用已保存的 load 設定。")
                    : t("目前載入的 load 設定與已保存一致；invoke／recording 變更於下一次呼叫生效。")}
                </p>
              </Callout>
            )
          ) : null}
          {patch.isError && (!hasErrorCode(patch.error, "REVISION_CONFLICT") || conflict === null) ? (
            <ErrorCallout error={patch.error} write title={t("儲存失敗；草稿仍保留")} onRetry={() => void settingsQuery.refetch()} retryLabel={t("重新讀取設定")} retrying={settingsQuery.isFetching} />
          ) : null}
          {(conflictError != null) ? <ErrorCallout error={conflictError} title={t("發生衝突，但無法讀取最新設定")} onRetry={() => void settingsQuery.refetch()} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton variant="primary" size="sm" icon={<Save aria-hidden />} pending={saving} disabledReason={saving ? null : saveReason} onClick={save}>
              {t("儲存設定")}
            </ActionButton>
            <Button size="sm" variant="secondary" icon={<Undo2 aria-hidden />} disabled={!draftEntry || saving} onClick={() => { onDraftEntryChange(null); }}>
              {t("捨棄修改")}
            </Button>
          </div>
        </div>
      </InspectorFooter>

      {weightsOpen ? <WeightsDialog entry={entry} open onOpenChange={setWeightsOpen} /> : null}
      {deleteOpen ? (
        <DeleteInstanceDialog
          entry={entry}
          open
          onOpenChange={setDeleteOpen}
          onDeleted={(deletedNode, deletedComponent) => {
            setDeleteOpen(false);
            onDeleted(deletedNode, deletedComponent);
          }}
        />
      ) : null}
      <ConflictDialog
        state={conflict}
        onClose={() => { setConflict(null); }}
        onDiscard={() => {
          if (conflict) onDraftEntryChange(null);
          patch.reset();
          setConflict(null);
        }}
        onRebase={() => {
          if (conflict && !rebaseOnto(conflict.latest, conflict.mine, conflict.base)) return;
          patch.reset();
          setConflict(null);
        }}
      />
    </div>
  );
}
