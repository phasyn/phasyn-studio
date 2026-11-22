// Stopping a resident component (autostart, weights kept on the GPU) is confirmed first: it was deliberately left
// running, and the routes that use it cannot render until it is started again.
import { PowerOff } from "lucide-react";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { nodeLabel, useCatalog } from "@/api/catalog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LastLoadNote } from "@/features/components";
import { t } from "@/i18n";

/** Resident components were deliberately left running (autostart, weights kept on the GPU): confirm before stopping. */
export function ResidentStopDialog({ component, onCancel, onConfirm }: { component: ComponentDescriptor | null; onCancel: () => void; onConfirm: (component: ComponentDescriptor) => void }) {
  const catalog = useCatalog();
  return (
    <Dialog open={component !== null} onOpenChange={(open) => { if (!(open)) { onCancel(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("停止常駐元件「{value}」？", { value: component ? component.label || component.component_id : "" })}</DialogTitle>
          <DialogDescription>
            {t("它是常駐元件：Node 服務啟動時自動載入、權重一直留在顯示卡，是刻意一直開著的。停止會釋放它佔用的顯示卡與主記憶體；用到它的運算路由在重新啟動它之前都不能渲染。")}
          </DialogDescription>
        </DialogHeader>
        {component ? (
          <DialogBody>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-data">
              <dt className="text-fg-tertiary">{t("元件")}</dt>
              <dd className="machine min-w-0 [overflow-wrap:anywhere] text-fg">{component.component_id}</dd>
              <dt className="text-fg-tertiary">Node</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere] text-fg">{nodeLabel(catalog.data, component.node_id)}</dd>
              <dt className="text-fg-tertiary">{t("裝置")}</dt>
              <dd className="machine min-w-0 [overflow-wrap:anywhere] text-fg">{component.device.resource_group}</dd>
              <dt className="text-fg-tertiary">{t("目前狀態")}</dt>
              <dd className="machine text-fg">{component.state}</dd>
            </dl>
            <div className="mt-2">
              <LastLoadNote nodeId={component.node_id} componentId={component.component_id} />
            </div>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button variant="quiet" onClick={onCancel}>
            {t("保持常駐")}
          </Button>
          <Button variant="danger" icon={<PowerOff aria-hidden />} onClick={() => { if (component) { onConfirm(component); } }}>
            {t("停止 {value}", { value: component?.component_id ?? "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
