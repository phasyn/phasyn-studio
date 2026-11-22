// One component of an engine sheet: kind tile (provider icon or art), name, a detail line (component・Node or why it is
// missing), the state badge and start／stop. The row shows its own queue phase; a reason that blocks starting (for
// example a busy member of the same exclusive group) is focusable on the disabled button.
import { Power, PowerOff } from "lucide-react";
import type { ReactNode } from "react";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { providerKind } from "@/components/workbench/kinds";
import { TILE_TONE } from "@/components/workbench/tones";
import { isResidentComponent, RESIDENT_HINT, type ControlPhase } from "@/features/components";
import { cn } from "@/lib/cn";
import { CARD } from "@/components/ui/look";
import { t } from "@/i18n";

const startable = (component: ComponentDescriptor | null): component is ComponentDescriptor => component !== null && (component.state === "stopped" || component.state === "error");

export interface ComponentRowProps {
  component: ComponentDescriptor | null;
  title: string;
  /** Short code next to the title (for example the pipeline step id). */
  tag?: string;
  /** Second line: "component・Node", or why the component cannot be used. */
  detail: ReactNode;
  detailTitle?: string;
  phase: ControlPhase | undefined;
  /** Why starting is not possible now; null = it can start. */
  blockStart?: string | null;
  onStart: (component: ComponentDescriptor) => void;
  onStop: (component: ComponentDescriptor) => void;
}

export function ComponentRow({ component, title, tag, detail, detailTitle, phase, blockStart = null, onStart, onStop }: ComponentRowProps) {
  const kind = providerKind(component?.provider_id);
  const resident = component !== null && isResidentComponent(component);
  const working = phase !== undefined;
  return (
    <li className={cn(CARD, "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-2.5 py-2")}>
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
        {component ? <StatusBadge kind="component" value={component.state} /> : null}
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
        {component && (component.state === "ready" || phase === "stopping") ? (
          <ActionButton
            size="sm"
            variant="quiet"
            icon={<PowerOff aria-hidden />}
            pending={phase === "stopping"}
            disabled={working && phase !== "stopping"}
            onClick={() => { onStop(component); }}
            title={resident ? t("常駐元件：停止前會先確認（停止會釋放顯示卡與主記憶體）") : t("停止並釋放顯示卡與主記憶體")}
          >
            {t("停止")}
          </ActionButton>
        ) : null}
      </span>
      <span className="min-w-0 truncate text-caption text-fg-tertiary" title={detailTitle}>
        {detail}
      </span>
    </li>
  );
}
