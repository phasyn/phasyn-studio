// Repairing a stored definition the provider refuses (last_error UNSUPPORTED_SETTING, see definitionCheck.ts). Fields
// the provider does not know go only with a full replacement: the current settings (with the inspector's unsaved
// edits, if any) minus those fields, sent once as PUT after confirmation, and only while the component is stopped.
// Unsupported values open the settings editor; when both kinds exist, the edits ride along with the replacement,
// because a settings PATCH is refused while unknown fields remain.
import { Eraser } from "lucide-react";
import { useRef, useState } from "react";
import type { ComponentEntry } from "@/api/catalog";
import { usePutComponent } from "@/api/components";
import type { InstanceSettings } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { definitionProblems, dottedPath, withoutFields, type SettingsPath } from "./definitionCheck";
import { t, tServer } from "@/i18n";

function ReplaceDefinitionDialog({
  entry,
  settings,
  removed,
  includesDraft,
  onOpenChange,
  onReplaced,
}: {
  entry: ComponentEntry;
  settings: InstanceSettings;
  removed: readonly SettingsPath[];
  includesDraft: boolean;
  onOpenChange: (open: boolean) => void;
  onReplaced: () => void;
}) {
  const { descriptor, node } = entry;
  const put = usePutComponent();
  const inFlight = useRef(false);
  const send = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    put.mutate(
      {
        nodeId: node.node_id,
        definition: {
          component_id: descriptor.component_id,
          label: descriptor.label,
          provider_id: descriptor.provider_id,
          runtime_id: descriptor.runtime_id,
          settings,
          autostart: descriptor.autostart,
          folder: descriptor.folder,
          ...(descriptor.exclusive_group ? { exclusive_group: descriptor.exclusive_group } : {}),
          ...(descriptor.limits ? { limits: descriptor.limits } : {}),
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          onReplaced();
        },
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => (put.isPending ? undefined : onOpenChange(open))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("移除 {count} 個欄位並替換定義？", { count: removed.length })}</DialogTitle>
          <DialogDescription>
            {t("以 PUT 送出整份定義：只移除下列 provider 不認得的欄位，名稱、資料夾、互斥群組、使用上限與其他設定照舊。只有 stopped 時才能替換定義；只送出一次，不會自動重試。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2">
          <ul aria-label={t("要移除的欄位")} className="grid gap-0.5">
            {removed.map((path) => (
              <li key={dottedPath(path)}>
                <code className="machine text-caption text-fg">{dottedPath(path)}</code>
              </li>
            ))}
          </ul>
          {includesDraft ? <p className="text-caption text-warning">{t("檢視器裡尚未儲存的設定修改也會一起送出。")}</p> : null}
          {put.isError ? <ErrorCallout error={put.error} write title={t("定義沒有替換")} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" disabled={put.isPending} onClick={() => onOpenChange(false)}>
            {t("取消")}
          </Button>
          <Button variant="danger" icon={<Eraser aria-hidden />} pending={put.isPending} onClick={send}>
            {t("移除並替換定義")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionRepair({
  entry,
  draft,
  draftChanged,
  onJump,
  onReplaced,
}: {
  entry: ComponentEntry;
  /** The inspector's settings draft (the stored settings when nothing is being edited). */
  draft: InstanceSettings;
  draftChanged: boolean;
  /** Opens the settings editor at a dotted path. */
  onJump: (path: string) => void;
  onReplaced: () => void;
}) {
  const { descriptor, node } = entry;
  const [confirming, setConfirming] = useState(false);
  const problems = definitionProblems(descriptor.last_error);
  if (!problems || !descriptor.last_error) return null;
  const { unknownFields, values } = problems;
  const blocked = node.stale
    ? t("Node 離線或狀態過時")
    : descriptor.state !== "stopped"
      ? t("只有 stopped 時才能替換定義（目前 {state}）", { state: descriptor.state })
      : null;
  return (
    <Callout tone="danger" title={t("已保存的定義有 provider 不接受的設定：修正後才能啟動")} className="m-2">
      {unknownFields.length > 0 ? (
        <div className="grid gap-1.5">
          <p>{t("provider 不認得的欄位（設定 PATCH 無法移除，只能替換整份定義）：")}</p>
          <ul aria-label={t("provider 不認得的欄位")} className="grid gap-0.5">
            {unknownFields.map((path) => (
              <li key={dottedPath(path)}>
                <code className="machine text-caption text-fg">{dottedPath(path)}</code>
              </li>
            ))}
          </ul>
          <div>
            <ActionButton size="sm" variant="danger" icon={<Eraser aria-hidden />} disabledReason={blocked} onClick={() => setConfirming(true)}>
              {t("移除這些欄位並替換定義…")}
            </ActionButton>
          </div>
        </div>
      ) : null}
      {values.length > 0 ? (
        <div className="grid gap-1.5">
          <p>
            {unknownFields.length > 0
              ? t("不支援的值：先在下方設定中修改（不用儲存），再按「移除這些欄位並替換定義」，修改會一起送出。")
              : t("不支援的值：在設定中修改後儲存。")}
          </p>
          <ul aria-label={t("不支援的值")} className="grid gap-0.5">
            {values.map((item) => (
              <li key={`${item.path}:${item.message}`} className="text-caption text-fg-secondary">
                <button type="button" className="machine text-left text-action-fg underline underline-offset-2 hover:text-action-hover" onClick={() => onJump(item.jump)}>
                  {item.path || t("（整份設定）")}
                </button>
                <span>{t("：{message}", { message: item.message })}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {unknownFields.length === 0 && values.length === 0 ? <p>{tServer(descriptor.last_error.message)}</p> : null}
      {confirming ? (
        <ReplaceDefinitionDialog
          entry={entry}
          settings={withoutFields(draft, unknownFields)}
          removed={unknownFields}
          includesDraft={draftChanged}
          onOpenChange={setConfirming}
          onReplaced={onReplaced}
        />
      ) : null}
    </Callout>
  );
}
