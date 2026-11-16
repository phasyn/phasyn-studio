import { Save, Tag, Undo2 } from "lucide-react";
import { useState } from "react";
import type { ComponentEntry } from "@/api/catalog";
import { usePatchComponentMeta } from "@/api/components";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Input, Switch, Textarea } from "@/components/ui/controls";
import { defaultFolderFor, folderOf, usesDefaultFolder, folderDisplayPath } from "@/components/workbench/componentFolders";
import { PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { buildMetaPatch, isInstanceGone, metaDraftOf, type MetaDraft } from "./componentsModel";
import { FolderInput } from "./FolderInput";
import { LIMITS_MAX_BYTES, parseLimits } from "./limitsModel";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/**
 * The inspector's "basic" section: display name, folder, autostart and limits (PATCH …/meta: allowed in any state, never
 * reloads the model). The exclusive group is shown only: meta cannot change it. The components page keeps the draft per
 * instance; saving sends only the changed fields, and a failure keeps the draft without resending.
 */
export function ComponentMetaSection({
  entry,
  draft,
  onDraftChange,
  suggestions,
  open,
  onOpenChange,
}: {
  entry: ComponentEntry;
  draft: MetaDraft | null;
  onDraftChange: (next: MetaDraft | null) => void;
  /** 這個 Node 現有的資料夾（輸入建議）。 */
  suggestions: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { descriptor, node } = entry;
  const meta = usePatchComponentMeta(node.node_id, descriptor.component_id);
  const [saved, setSaved] = useState(false);
  const current = draft ?? metaDraftOf(descriptor);
  const plan = buildMetaPatch(descriptor, current);
  const defaultFolder = defaultFolderFor(descriptor.provider_id);
  const idBase = `component-meta-${descriptor.component_id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const gone = meta.isError && isInstanceGone(meta.error);
  const limits = parseLimits(current.limits);

  const update = (patch: Partial<MetaDraft>) => {
    setSaved(false);
    onDraftChange({ ...current, ...patch });
  };

  const reason = meta.isPending
    ? null
    : plan.labelError || plan.folderError || plan.limitsError
      ? t("先修正欄位錯誤")
      : !plan.patch
        ? t("沒有變更")
        : node.stale
          ? t("Node 離線：無法保存到 Node")
          : null;

  const save = () => {
    if (reason || !plan.patch || meta.isPending) return;
    meta.mutate(plan.patch, {
      onSuccess: () => {
        onDraftChange(null);
        setSaved(true);
      },
    });
  };

  return (
    <PropertySection title={t("基本")} icon={<Tag aria-hidden />} open={open} onOpenChange={onOpenChange}>
      <PropertyGrid>
        <PropertyRow label={t("顯示名稱")} htmlFor={`${idBase}-label`}>
          <Input
            compact
            id={`${idBase}-label`}
            value={current.label}
            disabled={meta.isPending}
            aria-invalid={plan.labelError ? true : undefined}
            aria-describedby={plan.labelError ? `${idBase}-label-error` : undefined}
            onChange={(event) => update({ label: event.target.value })}
          />
          {plan.labelError ? (
            <span id={`${idBase}-label-error`} className="text-caption text-danger">
              {plan.labelError}
            </span>
          ) : null}
        </PropertyRow>
        <PropertyRow
          label={t("資料夾")}
          htmlFor={`${idBase}-folder`}
          hint={
            <>
              <T source={"目前：<0>{descriptor}</0>{value}。以「/」分層，最多 6 層；空白＝預設分類 <1>{defaultFolder}</1>。"} values={{ descriptor: folderDisplayPath(folderOf(descriptor)), value: usesDefaultFolder(descriptor) ? t("（依 provider 預設分類）") : "", defaultFolder: folderDisplayPath(defaultFolder) }} slots={[<span className="machine" />, <span className="machine" />]} />
            </>
          }
        >
          <FolderInput
            compact
            id={`${idBase}-folder`}
            value={current.folder}
            onChange={(folder) => update({ folder })}
            suggestions={suggestions}
            defaultFolder={defaultFolder}
            invalid={plan.folderError !== null}
            describedBy={plan.folderError ? `${idBase}-folder-error` : undefined}
            disabled={meta.isPending}
          />
          {plan.folderError ? (
            <span id={`${idBase}-folder-error`} className="text-caption text-danger">
              {plan.folderError}
            </span>
          ) : null}
        </PropertyRow>
        <PropertyRow label={t("自動啟動")} hint={t("只在 Node 服務啟動時處理一次；不是當機後自動重啟。")}>
          <Switch
            id={`${idBase}-autostart`}
            label={t("Node 服務啟動時自動載入這個元件")}
            checked={current.autostart}
            disabled={meta.isPending}
            onChange={(event) => update({ autostart: event.target.checked })}
            className="min-h-8 py-1"
          />
        </PropertyRow>
        <PropertyRow
          label={t("互斥群組")}
          hint={t("同一台 Node 上同群組的元件一次只能載入一個（例如 DiT 需要大量主記憶體），由 Node 在啟動時強制。群組在建立 instance 時設定，這裡只能檢視。")}
        >
          {descriptor.exclusive_group ? (
            <code className="machine text-data text-fg">{descriptor.exclusive_group}</code>
          ) : (
            <span className="text-data text-fg-tertiary">{t("無（不受互斥限制）")}</span>
          )}
        </PropertyRow>
        <PropertyRow
          label={t("使用上限（limits）")}
          htmlFor={`${idBase}-limits`}
          hint={t("JSON 物件，序列化後最多 16 KiB；內容由使用端讀取（例如 swap＝一鍵換角的上限），Node 只檢查格式與大小。留空＝沒有使用上限。")}
        >
          <Textarea
            compact
            id={`${idBase}-limits`}
            rows={5}
            spellCheck={false}
            className="machine"
            placeholder={'{ "swap": { … } }'}
            value={current.limits}
            disabled={meta.isPending}
            aria-invalid={plan.limitsError ? true : undefined}
            aria-describedby={`${idBase}-limits-status`}
            onChange={(event) => update({ limits: event.target.value })}
          />
          <span id={`${idBase}-limits-status`} className={plan.limitsError ? "text-caption text-danger" : "text-caption text-fg-tertiary"}>
            {plan.limitsError ??
              (limits.ok && limits.value !== null ? t("{bytes}／{max} bytes", { bytes: limits.bytes, max: LIMITS_MAX_BYTES }) : t("沒有使用上限"))}
          </span>
        </PropertyRow>
      </PropertyGrid>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ActionButton size="sm" icon={<Save aria-hidden />} pending={meta.isPending} disabledReason={reason} onClick={save}>
          {t("儲存基本資料")}
        </ActionButton>
        <Button size="sm" variant="quiet" icon={<Undo2 aria-hidden />} disabled={!draft || meta.isPending} onClick={() => onDraftChange(null)}>
          {t("還原", undefined, { context: "revert" })}
        </Button>
        <span aria-live="polite" className="text-caption">
          {saved && !draft ? (
            <span className="inline-block text-success animate-rise-in">{t("已儲存；不需要重新載入模型。")}</span>
          ) : plan.dirty ? (
            <span className="text-warning">{t("有未儲存的修改")}</span>
          ) : null}
        </span>
      </div>
      {meta.isError ? (
        <ErrorCallout error={meta.error} write title={t("基本資料沒有儲存；草稿保留")} className="mt-2">
          {gone ? <p className="text-caption text-fg-secondary">{t("Node 上已經沒有這個 instance（可能已被刪除），草稿無法儲存。")}</p> : null}
        </ErrorCallout>
      ) : null}
    </PropertySection>
  );
}
