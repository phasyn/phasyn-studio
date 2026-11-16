import { LoaderCircle, Trash2, Workflow } from "lucide-react";
import { Link } from "react-router";
import type { ComponentEntry } from "@/api/catalog";
import { useDeleteComponent } from "@/api/components";
import { usePipelines } from "@/api/pipelines";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteBlockReason, isInstanceGone, pipelinesUsing } from "./componentsModel";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

function PipelineUsage({ nodeId, componentId }: { nodeId: string; componentId: string }) {
  const pipelines = usePipelines();
  if (pipelines.isPending) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
        <LoaderCircle aria-hidden className="size-3.5 shrink-0 text-info animate-spin" />
        {t("正在確認哪些元件組合使用它…")}
      </p>
    );
  }
  if (pipelines.isError && !pipelines.data) {
    return <ErrorCallout error={pipelines.error} title={t("無法確認哪些元件組合使用它（刪除仍可進行）")} onRetry={() => void pipelines.refetch()} retrying={pipelines.isFetching} />;
  }
  const uses = pipelinesUsing(pipelines.data?.items ?? [], nodeId, componentId);
  if (uses.length === 0) return <p className="text-caption text-fg-tertiary">{t("目前沒有元件組合使用它。")}</p>;
  return (
    <ul aria-label={t("使用它的元件組合")} className="grid gap-1 rounded-md border border-line-subtle bg-sunken px-3 py-2">
      {uses.map((use) => (
        <li key={use.pipelineId} className="flex min-w-0 flex-wrap items-center gap-x-2 text-data">
          <Workflow aria-hidden className="size-3.5 shrink-0 text-fg-tertiary" />
          <Link to={`/admin/pipelines/${encodeURIComponent(use.pipelineId)}`} className="min-w-0 [overflow-wrap:anywhere]">
            {use.label}
          </Link>
          <span className="text-caption text-fg-tertiary">
            <T source={"步驟 {span}"} values={{ span: <span className="machine">{formatList(use.stepIds)}</span> }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 刪除 instance（只允許已停止或錯誤）：確認框寫明範圍——定義從 Node 移除、設定檔的同名 seed 之後不會在重啟時重建、
 * 效能紀錄與檔案保留、使用它的元件組合會顯示「未知元件」。不自動重送。
 */
export function DeleteInstanceDialog({
  entry,
  open,
  onOpenChange,
  onDeleted,
}: {
  entry: ComponentEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (nodeId: string, componentId: string) => void;
}) {
  const { descriptor, node } = entry;
  const remove = useDeleteComponent(node.node_id, descriptor.component_id);
  const blocked = deleteBlockReason(entry);
  const gone = remove.isError && isInstanceGone(remove.error);
  const name = descriptor.label || descriptor.component_id;

  const confirm = () => {
    if (blocked || remove.isPending) return;
    // mutateAsync：即使檢視器在完成前因目錄更新而卸載，頁面仍會收到結果。
    void remove.mutateAsync().then(
      () => onDeleted(node.node_id, descriptor.component_id),
      () => undefined,
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (remove.isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("刪除 instance「{name}」？", { name })}</DialogTitle>
          <DialogDescription>
            <span className="machine">{descriptor.component_id}</span> · {node.label}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          <ul className="grid list-disc gap-1 pl-5 text-data text-fg-secondary">
            <li>{t("定義會從 Node「{label}」移除。", { label: node.label })}</li>
            <li>{t("Node 設定檔的同名 seed 之後不會在重啟時重建。")}</li>
            <li>{t("效能紀錄與檔案保留。")}</li>
            <li>{t("使用它的元件組合會顯示「未知元件」，要改選其他 instance 才能執行。")}</li>
          </ul>
          <PipelineUsage nodeId={node.node_id} componentId={descriptor.component_id} />
          {blocked ? <p className="text-caption text-warning">{t("{blocked}。", { blocked })}</p> : null}
          {remove.isError ? (
            <ErrorCallout error={remove.error} write title={t("沒有刪除")}>
              {gone ? <p className="text-caption text-fg-secondary">{t("Node 上已經沒有這個 instance（可能已在其他地方刪除）；目錄更新後就不會再列出。")}</p> : null}
            </ErrorCallout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            {t("取消")}
          </Button>
          <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} pending={remove.isPending} disabled={Boolean(blocked) || remove.isPending} title={blocked ?? undefined} onClick={confirm}>
            {t("刪除 instance")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
