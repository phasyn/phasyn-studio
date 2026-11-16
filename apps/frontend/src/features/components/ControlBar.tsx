import { Ban, Play, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { type ComponentEntry, useCatalog } from "@/api/catalog";
import { useCancelCall, useControlComponent } from "@/api/components";
import type { ControlRequest } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { conflictFromError, ExclusiveBusy, exclusiveBlockReason, exclusiveConflict, exclusiveReplaceNote, requestStart } from "./control/exclusive";
import { LastLoadNote } from "./LastLoadNote";
import { isResidentComponent, RESIDENT_HINT } from "./resident";
import { useExclusiveConfirm } from "./control/useExclusiveConfirm";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";

type Action = ControlRequest["action"];

function reasonFor(action: Action, entry: ComponentEntry): string | null {
  const state = entry.descriptor.state;
  if (entry.node.stale) return t("Node 離線或狀態過時：無法送出控制命令");
  if (action === "start") {
    if (state === "loading") return t("正在載入");
    if (state === "ready") return t("已就緒（重複 start 不會再載入一份）");
    if (state === "busy") return t("呼叫進行中");
    if (state === "stopping") return t("正在停止，請等待狀態變為已停止");
    return null;
  }
  if (state === "busy") return t("請先取消進行中的呼叫");
  if (action === "stop") {
    if (state === "stopped") return t("已停止");
    if (state === "stopping") return t("正在停止");
    return null;
  }
  if (state === "loading") return t("正在載入，請等待載入完成");
  if (state === "stopping") return t("正在停止，請等待狀態穩定");
  return null;
}

// 「重新載入」在這裡是元件 restart（不是重新整理頁面）：用 context 區分譯文
const LABEL: Record<Action, string> = { start: t("啟動"), stop: t("停止"), restart: t("重新載入", undefined, { context: "restart" }) };

/**
 * 進行中（載入中、呼叫進行中）的不確定進度條：沒有真實的完成比例，所以不畫百分比；品牌淡漸層＋掃過的高光只表示「正在進行」。
 * 狀態以旁邊的文字說明，進度條本身是裝飾（aria-hidden）。
 */
function WorkingBar() {
  return <span aria-hidden className="block h-1 w-full rounded-full bg-brand-gradient-soft ring-1 ring-brand-blue/25 ring-inset animate-shimmer" />;
}
const ICON = { start: <Play aria-hidden />, stop: <Square aria-hidden />, restart: <RotateCw aria-hidden /> } as const;

/** start／stop／restart／取消進行中呼叫：pending 時不重複送命令；不可用一律說明原因。 */
export function ControlBar({ entry }: { entry: ComponentEntry }) {
  const nodeId = entry.node.node_id;
  const componentId = entry.descriptor.component_id;
  const control = useControlComponent(nodeId, componentId);
  const cancel = useCancelCall(nodeId, componentId);
  const activeCall = entry.descriptor.active_call_id;
  const busy = entry.descriptor.state === "busy";
  // 互斥群組：同一台 Node 的其他成員已載入時，啟動前先確認讓 Node 停止它們；正在使用的成員會擋下並說明
  const catalog = useCatalog();
  const exclusive = useExclusiveConfirm();
  const conflict = exclusiveConflict(entry.descriptor, catalog.data);
  const exclusiveReason = exclusiveBlockReason(conflict);
  /** start／restart 在確認或送出中（確認框開著時也算）。 */
  const [requesting, setRequesting] = useState<Action | null>(null);
  const [exclusiveError, setExclusiveError] = useState<unknown>(null);
  // 常駐元件（使用者決定一直開著）：停止前先確認
  const resident = isResidentComponent(entry.descriptor);
  const [confirmStop, setConfirmStop] = useState(false);
  const run = async (action: Action, confirmed = false) => {
    if (action === "stop" && resident && !confirmed) {
      setConfirmStop(true);
      return;
    }
    if (action === "stop") {
      control.mutate({ action });
      return;
    }
    setExclusiveError(null);
    setRequesting(action);
    try {
      await requestStart(entry.descriptor, { action, catalog: catalog.data, confirm: exclusive.confirm, send: (body) => control.mutateAsync(body) });
    } catch (error) {
      // 控制請求本身的錯誤由 control.error 顯示；這裡只留沒有送出的原因（互斥成員正在使用）。
      if (error instanceof ExclusiveBusy) setExclusiveError(error);
    } finally {
      setRequesting(null);
    }
  };
  // 已由確認框處理的互斥衝突（409 EXCLUSIVE_GROUP_CONFLICT）不再另外顯示成錯誤。
  const controlError = control.isError && conflictFromError(control.error)?.busy !== false ? { error: control.error, action: control.variables.action } : null;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["start", "stop", "restart"] as const).map((action) => (
          <ActionButton
            key={action}
            size="sm"
            variant={action === "stop" ? "danger" : "secondary"}
            icon={ICON[action]}
            pending={(control.isPending && control.variables.action === action) || requesting === action}
            disabledReason={
              control.isPending && control.variables.action !== action
                ? t("上一個控制命令處理中")
                : (reasonFor(action, entry) ?? (action === "start" ? exclusiveReason : null))
            }
            title={action === "stop" && resident ? t("常駐元件：停止前會先確認") : undefined}
            onClick={() => void run(action)}
          >
            {LABEL[action]}
          </ActionButton>
        ))}
        {activeCall ? (
          <ActionButton
            size="sm"
            variant="danger"
            icon={<Ban aria-hidden />}
            pending={cancel.isPending}
            disabledReason={entry.node.stale ? t("Node 離線或狀態過時：無法送出取消") : null}
            onClick={() => cancel.mutate(activeCall)}
          >
            {t("取消進行中的呼叫")}
          </ActionButton>
        ) : null}
      </div>
      {entry.descriptor.state === "loading" ? (
        <div className="grid gap-1 animate-rise-in">
          <WorkingBar />
          <p className="text-caption text-fg-secondary">{t("載入中…")}</p>
        </div>
      ) : null}
      {busy ? (
        <div className="grid gap-1 animate-rise-in">
          <WorkingBar />
          <p className="text-caption text-fg-secondary">{t("呼叫進行中：stop／restart 需先取消進行中的呼叫；仍可儲存設定（下次呼叫或載入時採用）。")}</p>
        </div>
      ) : null}
      {resident ? <p className="text-caption text-info">{t("{residentHint}。", { residentHint: RESIDENT_HINT })}</p> : null}
      {conflict && !exclusiveReason && entry.descriptor.state !== "ready" && entry.descriptor.state !== "busy" ? (
        <p className="text-caption text-warning">{exclusiveReplaceNote(conflict)}</p>
      ) : null}
      {exclusiveError ? <ErrorCallout error={exclusiveError} title={t("沒有啟動：互斥群組的其他元件正在使用")} /> : null}
      {control.isSuccess && !control.isPending ? (
        <p className="text-caption text-fg-secondary animate-rise-in" role="status">
          {/* The Node replies once it has taken the command: the stop or the load goes on after the reply */}
          {control.variables.action === "stop" ? (
            <T source={"已送出「{variables}」：Node 回覆狀態 <0>{state}</0>；後續狀態由目錄輪詢更新，不代表程序已經結束。"} values={{ variables: LABEL.stop, state: control.data.state }} slots={[<code className="machine" />]} />
          ) : (
            <T source={"已送出「{variables}」：Node 回覆狀態 <0>{state}</0>；後續狀態由目錄輪詢更新，不代表載入已完成。"} values={{ variables: LABEL[control.variables.action], state: control.data.state }} slots={[<code className="machine" />]} />
          )}
        </p>
      ) : null}
      {controlError ? <ErrorCallout error={controlError.error} write title={t("「{variables}」未完成", { variables: LABEL[controlError.action] })} /> : null}
      {cancel.isSuccess ? (
        <Callout tone={cancel.data.accepted ? "info" : "warning"} title={cancel.data.accepted ? t("已受理取消") : t("取消未受理")} className="animate-rise-in">
          <p>{tServer(cancel.data.message)}</p>
          <p className="text-caption text-fg-tertiary">
            {t("程序已結束：{value}", { value: cancel.data.process_exited === null ? t("未知") : cancel.data.process_exited ? t("是") : t("否") })}
          </p>
        </Callout>
      ) : null}
      {cancel.isError ? <ErrorCallout error={cancel.error} write title={t("取消請求失敗")} /> : null}
      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("停止常駐元件「{value}」？", { value: entry.descriptor.label || componentId })}</DialogTitle>
            <DialogDescription>
              {t("它是常駐元件：Node 服務啟動時自動載入、權重一直留在顯示卡，是刻意一直開著的。停止會釋放它佔用的顯示卡與主記憶體；用到它的元件組合在重新啟動前都會在該步驟失敗。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2">
            <p className="machine text-caption text-fg-tertiary">
              {t("{componentId}・{label}・{resource_group}", { componentId, label: entry.node.label, resource_group: entry.descriptor.device.resource_group })}
            </p>
            <LastLoadNote nodeId={nodeId} componentId={componentId} />
          </DialogBody>
          <DialogFooter>
            <Button variant="quiet" onClick={() => setConfirmStop(false)}>
              {t("保持常駐")}
            </Button>
            <Button
              variant="danger"
              icon={<Square aria-hidden />}
              onClick={() => {
                setConfirmStop(false);
                void run("stop", true);
              }}
            >
              {t("停止 {componentId}", { componentId })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {exclusive.dialog}
    </div>
  );
}
