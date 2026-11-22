// One component on the engine sheet's 元件 tab: kind tile, name and step, a detail line (component・machine, or why it
// is missing), the state chip and 啟動 when it is stopped. 停止 unloads a model, which costs a reload, so it is not a
// button next to every state: it appears on the row while the pointer is over it or focus is inside it (Tab reaches
// it, and it stays visible while it is stopping); a resident component asks before stopping (the engine control).
// Same contract as the shell's ComponentRow, which Image Studio keeps.
import { componentAvailability } from "@/api/catalog";
import { Power, PowerOff } from "lucide-react";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { CARD } from "@/components/ui/look";
import { providerKind } from "@/components/workbench/kinds";
import { TILE_TONE } from "@/components/workbench/tones";
import { isResidentComponent, RESIDENT_HINT } from "@/features/components";
import type { ComponentRowProps } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

const startable = (component: ComponentDescriptor | null): component is ComponentDescriptor => component !== null && (component.state === "stopped" || component.state === "error");

export function EngineComponentRow({ component, title, tag, detail, detailTitle, phase, blockStart = null, onStart, onStop }: ComponentRowProps) {
  const kind = providerKind(component?.provider_id);
  const resident = component !== null && isResidentComponent(component);
  const working = phase !== undefined;
  const stoppable = component !== null && (component.state === "ready" || phase === "stopping") ? component : null;
  return (
    <li className={cn(CARD, "group/crow grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-2.5 py-2")}>
      <span aria-hidden className={cn("row-span-2 grid size-9 place-items-center overflow-hidden rounded-md border", TILE_TONE[kind.tone])}>
        {(kind.art != null && kind.art !== "") ? <img src={kind.art} alt="" className="size-7 object-contain" draggable={false} /> : <kind.icon className="size-4" />}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-data text-fg">
        <span className="truncate">{title}</span>
        {(tag != null && tag !== "") ? <code className="machine shrink-0 text-caption text-fg-tertiary">{tag}</code> : null}
        {resident ? (
          <span title={RESIDENT_HINT} className="shrink-0 rounded-full border border-info/30 bg-info/10 px-1.5 text-[11px] leading-4 text-info">
            {t("常駐")}
          </span>
        ) : null}
      </span>
      <span className="row-span-2 flex items-center gap-1.5">
        {stoppable ? (
          <ActionButton
            size="sm"
            variant="quiet"
            icon={<PowerOff aria-hidden />}
            pending={phase === "stopping"}
            disabled={working && phase !== "stopping"}
            onClick={() => { onStop(stoppable); }}
            title={resident ? t("常駐元件：停止前會先確認（停止會釋放顯示卡與主記憶體）") : t("停止並釋放顯示卡與主記憶體")}
            className={cn("min-h-7 px-2", phase === "stopping" ? "opacity-100" : "opacity-0 group-hover/crow:opacity-100 group-focus-within/crow:opacity-100 focus-visible:opacity-100")}
          >
            {t("停止")}
          </ActionButton>
        ) : null}
        {component && componentAvailability(component) === "on_use" ? (
          <span title={t("用到才載入：渲染用到它時主控會自動載入")} className="shrink-0 text-caption text-info">
            {t("使用時載入")}
          </span>
        ) : component ? <StatusBadge kind="component" value={component.state} /> : null}
        {startable(component) || phase === "queued" || phase === "starting" ? (
          <ActionButton
            size="sm"
            variant="secondary"
            icon={<Power aria-hidden />}
            pending={phase === "queued" || phase === "starting"}
            disabledReason={working ? null : blockStart}
            onClick={() => { if (component) { onStart(component); } }}
            title={phase === "queued" ? t("排隊中：同一張卡的元件依序載入") : undefined}
          >
            {t("啟動")}
          </ActionButton>
        ) : null}
      </span>
      <span className="min-w-0 truncate text-caption text-fg-tertiary" title={detailTitle}>
        {detail}
      </span>
    </li>
  );
}
