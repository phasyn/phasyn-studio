// Confirmation dialog before the Node replaces the loaded members of an exclusive group (driven by useExclusiveConfirm).
// The components to be stopped and the one to be loaded are listed apart; the load-time note sits with the latter.
import { Repeat2 } from "lucide-react";
import { useId } from "react";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ExclusiveConflict, ExclusiveTarget } from "./exclusive";
import { LastLoadNote } from "../LastLoadNote";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface PendingConfirm {
  conflict: ExclusiveConflict;
  target: ExclusiveTarget;
  resolve: (confirmed: boolean) => void;
}

export function ExclusiveConfirmDialog({ request, onSettle }: { request: PendingConfirm | null; onSettle: (confirmed: boolean) => void }) {
  const id = useId();
  const holders = request ? formatList(request.conflict.holders.map((holder) => holder.component_id)) : "";
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!(open)) { onSettle(false); } }}>
      <DialogContent>
        {request ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("停止 {holders} 並啟動 {component_id}？", { holders, component_id: request.target.component_id })}</DialogTitle>
              <DialogDescription>
                {t("同一台 Node 的互斥群組 {group} 一次只能載入一個元件。確認後 Node 會先依序停止下列元件，再載入 {component_id}；停止失敗就不會載入。", {
                  group: request.conflict.group,
                  component_id: request.target.component_id,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="grid gap-3">
              <div className="grid gap-1">
                <h3 id={`${id}-stop`} className="text-caption text-fg-tertiary">
                  {t("會被停止的元件")}
                </h3>
                <ul aria-labelledby={`${id}-stop`} className="grid gap-1 rounded-md border border-line-subtle bg-sunken px-3 py-2">
                  {request.conflict.holders.map((holder) => (
                    <li key={holder.component_id} className="flex min-w-0 items-center justify-between gap-2 text-data">
                      <span className="machine min-w-0 [overflow-wrap:anywhere] text-fg">{holder.component_id}</span>
                      <StatusBadge kind="component" value={holder.state} />
                    </li>
                  ))}
                </ul>
              </div>
              <div role="group" aria-labelledby={`${id}-load`} className="grid gap-1">
                <h3 id={`${id}-load`} className="text-caption text-fg-tertiary">
                  {t("接著載入的元件")}
                </h3>
                <div className="grid gap-1 rounded-md border border-line-subtle bg-sunken px-3 py-2">
                  <span className="machine min-w-0 text-data [overflow-wrap:anywhere] text-fg">{request.target.component_id}</span>
                  <LastLoadNote nodeId={request.target.node_id} componentId={request.target.component_id} action="load" />
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="quiet" onClick={() => { onSettle(false); }}>
                {t("取消")}
              </Button>
              <Button variant="danger" icon={<Repeat2 aria-hidden />} onClick={() => { onSettle(true); }}>
                {t("停止並啟動")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
