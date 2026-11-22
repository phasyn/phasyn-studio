// Start／stop for the engine sheets of both Studios, on top of the components feature's single implementation
// (useComponentControl: one request each, same Node + resource group in order, exclusive groups confirmed by the user,
// never resent). This adds the Studio notices and asks before stopping a resident component.
import { useState, type ReactNode } from "react";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { instanceKey } from "@/api/types";
import { isResidentComponent, useComponentControl, type ControlEvent, type ControlPhase } from "@/features/components";
import type { NoticeInput } from "../notices/useNotices";
import { ResidentStopDialog } from "./ResidentStopDialog";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface EngineControl {
  phaseOf: (component: Pick<ComponentDescriptor, "node_id" | "component_id">) => ControlPhase | undefined;
  /** Any of these components is queued, starting or stopping. */
  busy: (components: readonly (ComponentDescriptor | null)[]) => boolean;
  start: (components: readonly ComponentDescriptor[]) => void;
  /** Stops one component; a resident one is confirmed first. */
  stop: (component: ComponentDescriptor) => void;
  /** Exclusive-group and resident confirmations: render once inside the sheet. */
  dialogs: ReactNode;
}

function noticeFor(event: ControlEvent): NoticeInput | null {
  const name = event.target.label || event.target.component_id;
  if (event.outcome.kind === "done") {
    return event.outcome.replaced.length > 0
      ? { tone: "info", title: t("已先停止 {stopped}", { stopped: formatList(event.outcome.replaced) }), detail: t("同一台 Node 的同一個互斥群組一次只能載入一個元件") }
      : null;
  }
  const failure = event.outcome.failure;
  if (failure.skipped === true) return null;
  const title = failure.unknown
    ? t("{name} 的結果未知", { name })
    : event.action === "start"
      ? t("{name} 啟動失敗", { name })
      : t("{name} 停止失敗", { name });
  return { tone: failure.unknown ? "warning" : "danger", title, detail: failure.message };
}

export function useEngineControl(notify: (notice: NoticeInput) => void): EngineControl {
  const control = useComponentControl({
    onEvent: (event) => {
      const notice = noticeFor(event);
      if (notice) notify(notice);
    },
  });
  const [confirmStop, setConfirmStop] = useState<ComponentDescriptor | null>(null);
  const phaseOf = (component: Pick<ComponentDescriptor, "node_id" | "component_id">) => control.phase[instanceKey(component.node_id, component.component_id)];
  return {
    phaseOf,
    busy: (components) => components.some((component) => component !== null && phaseOf(component) !== undefined),
    start: (components) => void control.run(components, "start"),
    stop: (component) => {
      if (isResidentComponent(component)) setConfirmStop(component);
      else void control.run([component], "stop");
    },
    dialogs: (
      <>
        {control.dialog}
        <ResidentStopDialog
          component={confirmStop}
          onCancel={() => { setConfirmStop(null); }}
          onConfirm={(component) => {
            setConfirmStop(null);
            void control.run([component], "stop");
          }}
        />
      </>
    ),
  };
}
