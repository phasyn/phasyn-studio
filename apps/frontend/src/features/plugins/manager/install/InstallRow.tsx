// 進行中的安裝：清單頂端的一列——檔名、大小與三個步驟（驗證 → 確認 → 安裝），逐項亮起。點這一列就在右欄看預覽或失敗原因。
// 驗證可以取消；安裝請求送出後只能等它結束。
import { FileArchive, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ICON_TILE } from "@/components/ui/look";
import { Stepper, type StepperStep, type StepState } from "@/components/workbench/Stepper";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { useManager } from "../managerContext";
import type { InstallState } from "./useInstallFlow";

function stepStates(state: InstallState): [StepState, StepState, StepState] {
  switch (state.phase) {
    case "checking":
      return ["active", "pending", "pending"];
    case "preview":
      return ["done", "active", "pending"];
    case "installing":
      return ["done", "done", "active"];
    case "done":
      return ["done", "done", "done"];
    case "failed":
      return state.stage === "check" ? ["error", "pending", "pending"] : ["done", "done", "error"];
    default:
      return ["pending", "pending", "pending"];
  }
}

function installSteps(state: InstallState): StepperStep[] {
  const [check, review, apply] = stepStates(state);
  return [
    { id: "check", label: t("驗證"), state: check },
    { id: "review", label: t("確認"), state: review },
    { id: "install", label: state.phase === "done" ? t("已安裝") : t("安裝"), state: apply },
  ];
}

export function InstallRow() {
  const { install, installed, setInstalled } = useManager();
  const state = install.state;
  if (state.phase === "idle") return null;
  const shown = installed.pane === "install";
  const size = "size" in state ? formatBytes(state.size) : null;
  const closable = state.phase !== "installing";
  return (
    <div
      role="group"
      aria-label={t("安裝插件")}
      className={cn("flex min-h-12 shrink-0 animate-rise-in items-center gap-3 border-b border-line-subtle px-3", shown ? "bg-brand-gradient-soft" : "bg-canvas/60")}
    >
      <button
        type="button"
        aria-pressed={shown}
        onClick={() => setInstalled({ pane: "install" })}
        title={state.fileName}
        className="pressable flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 text-left"
      >
        <span aria-hidden className={cn(ICON_TILE, "size-7 [&_svg]:size-4")}>
          <FileArchive />
        </span>
        <span className="truncate text-body text-fg">{state.fileName}</span>
        {size ? <span className="machine shrink-0 text-caption text-fg-tertiary">{size}</span> : null}
      </button>
      <Stepper size="sm" label={t("安裝步驟")} steps={installSteps(state)} />
      {closable ? (
        <Button
          size="icon-sm"
          variant="quiet"
          aria-label={state.phase === "checking" || state.phase === "preview" ? t("取消安裝") : t("關閉")}
          title={state.phase === "checking" || state.phase === "preview" ? t("取消安裝") : t("關閉")}
          onClick={install.dismiss}
          icon={<X aria-hidden />}
        />
      ) : null}
    </div>
  );
}
