// 移除一個已安裝的包的確認框：先讀主控的移除預覽（哪些專案還在使用它、能不能移除），列出受影響的專案後才確認。
// 移除只刪主控上這個包的檔案與安裝紀錄，從不修改任何專案：專案裡的引用會保留並顯示為找不到，那些專案在移除引用或
// 重新安裝之前不能渲染。確認時帶上預覽看到的 digest；主控上的包已經不同時會拒絕。
import { FolderKanban, Trash2 } from "lucide-react";
import type { StudioPlugin, StudioPluginId, StudioPluginProjectUse, StudioPluginRemovalPreview } from "@/api/generated/contracts";
import { useMutation } from "@tanstack/react-query";
import { removePlugin, useInvalidatePlugins, useRemovalPreview } from "@/api/plugins";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { pluginName } from "../model/evaluate";
import type { PluginRegistry } from "../model/registry";
import { pluginText } from "../model/text";
import { IssueList } from "../parts/IssueList";
import { PluginTile } from "../parts/kinds";
import { useRevealRef } from "../parts/motion";
import { useManager } from "./managerContext";

function refLabel(registry: PluginRegistry, ref: string): string {
  const rule = registry.rules.get(ref);
  if (rule) return pluginText(rule.rule.label, ref);
  const generation = registry.generation.get(ref);
  return generation ? pluginText(generation.generation.label, ref) : ref;
}

function ProjectRow({ index, use, registry, current }: { index: number; use: StudioPluginProjectUse; registry: PluginRegistry; current: boolean }) {
  const enter = useRevealRef(index);
  const title = use.title || use.project_id;
  return (
    <li ref={enter} className="flex min-w-0 items-start gap-2.5 px-3 py-2">
      <FolderKanban aria-hidden className="mt-0.5 size-4 shrink-0 text-entity" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="flex min-w-0 items-baseline gap-2 text-data text-fg">
          <span title={title} className="truncate">
            {title}
          </span>
          {current ? <span className="shrink-0 text-caption text-brand-cyan">{t("目前的專案")}</span> : null}
        </p>
        <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{formatList(use.refs.map((ref) => refLabel(registry, ref)))}</p>
      </div>
    </li>
  );
}

function Impact({ preview }: { preview: StudioPluginRemovalPreview }) {
  const { registry, project } = useManager();
  if (!preview.can_remove) return <IssueList issues={preview.blocking} tone="danger" label={t("不能移除的原因")} />;
  if (preview.projects.length === 0) return <Callout tone="success" title={t("沒有專案在使用它")} />;
  return (
    <>
      <Callout tone="warning" title={t("{count} 個專案還在使用它", { count: preview.projects.length })}>
        <p>{t("移除不會修改這些專案：它們會顯示找不到這些項目，在移除引用或重新安裝之前不能渲染。")}</p>
      </Callout>
      <ul aria-label={t("還在使用它的專案")} className="grid max-h-64 divide-y divide-line-subtle overflow-y-auto rounded-lg border border-line-subtle bg-canvas/60">
        {preview.projects.map((use, index) => (
          <ProjectRow key={use.project_id} index={index} use={use} registry={registry} current={use.project_id === project?.projectId} />
        ))}
      </ul>
    </>
  );
}

function Summary({ plugin }: { plugin: StudioPlugin }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-line-subtle bg-canvas/60 p-2.5">
      <PluginTile plugin={plugin} size="lg" />
      <div className="grid min-w-0 gap-0.5">
        <p className="truncate text-body font-semibold text-fg">{pluginName(plugin)}</p>
        <p className="machine truncate text-caption text-fg-tertiary">{[plugin.plugin_id, plugin.version].filter(Boolean).join(" · ")}</p>
      </div>
    </div>
  );
}

export function RemoveDialog({ pluginId, onClose, onRemoved }: { pluginId: StudioPluginId | null; onClose: () => void; onRemoved: (pluginId: StudioPluginId) => void }) {
  const { registry, notify } = useManager();
  const plugin = pluginId ? (registry.plugins.get(pluginId) ?? null) : null;
  const query = useRemovalPreview(plugin ? plugin.plugin_id : null);
  const invalidate = useInvalidatePlugins();
  // 結果由 mutation 自己處理：確認框即使已經不在畫面上，移除完成的訊息仍然會送到
  const remove = useMutation({
    mutationFn: ({ plugin: target, digest: seen }: { plugin: StudioPlugin; digest: string }) => removePlugin(target.plugin_id, seen),
    onSuccess: (result, { plugin: target }) => {
      const name = pluginName(target);
      const count = result.projects.length;
      notify("success", count > 0 ? t("已移除「{name}」；{count} 個專案仍引用它", { name, count }) : t("已移除「{name}」", { name }));
      onRemoved(target.plugin_id);
      onClose();
    },
    onSettled: () => void invalidate(),
  });
  const preview = query.data ?? null;
  const digest = preview?.can_remove ? preview.digest : null;
  const confirm = () => {
    if (plugin && digest && !remove.isPending) remove.mutate({ plugin, digest });
  };
  const close = () => {
    // 移除的請求送出後不能收回：等它有結果（成功會自己關閉，失敗留在這裡說明原因）
    if (remove.isPending) return;
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={plugin !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {plugin ? (
        <DialogContent onKeyDown={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("移除「{name}」？", { name: pluginName(plugin) })}</DialogTitle>
            <DialogDescription>{t("從主控刪除這個包的檔案與安裝紀錄；任何專案都不會被修改。")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <Summary plugin={plugin} />
            {query.isPending ? (
              <div role="status" aria-label={t("讀取移除的影響範圍…")} className="grid gap-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : null}
            {query.isError ? <ErrorCallout error={query.error} title={t("讀不到移除的影響範圍")} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
            {preview ? <Impact preview={preview} /> : null}
            {remove.isError ? <ErrorCallout error={remove.error} write title={t("沒有移除")} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={remove.isPending}>{digest ? t("取消") : t("關閉")}</Button>
            </DialogClose>
            <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} disabled={!digest} pending={remove.isPending} onClick={confirm}>
              {t("移除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
