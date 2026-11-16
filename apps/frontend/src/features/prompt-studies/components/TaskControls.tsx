// 未結束任務的控制：下一步是什麼、繼續（逐步或連續）、上一步失敗時明確重試、結束任務（確認後；已完成的結果保留）。
import { CircleStop, Play, RotateCcw, StepForward } from "lucide-react";
import { useId, useState } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TaskRunner } from "../hooks/useTaskRunner";
import { continueBlock } from "../model/blocks";
import { describeStep, isRunStep, planTask, searchProgress } from "../model/planner";
import { TASK_LABELS } from "../model/study";
import type { PromptStudy, PromptStudyTask } from "../types";
import { stepErrorText } from "../model/stepError";
import { t } from "@/i18n";

export function EndTaskDialog({ task, open, onOpenChange, onConfirm }: { task: PromptStudyTask | null; open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("結束「{value}」？", { value: task ? TASK_LABELS[task.kind] : t("任務") })}</DialogTitle>
          <DialogDescription>{t("結束後不能再繼續這個任務；要再做一次請建立新的任務（新的預算）。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="text-data text-fg-secondary">
          <p>{t("已完成的圖片、比較、評分與新版本都保留；不會取消任何 run，也不會刪除檔案。")}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            {t("不要結束")}
          </Button>
          <Button
            variant="danger-confirm"
            icon={<CircleStop aria-hidden />}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t("結束任務")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 未結束任務的下一步說明與控制；有搜尋輪數選擇（有界搜尋）。 */
export function TaskControls({ study, task, runner, allowRounds = false }: { study: PromptStudy; task: PromptStudyTask; runner: TaskRunner; allowRounds?: boolean }) {
  const id = useId();
  const [ending, setEnding] = useState(false);
  const [rounds, setRounds] = useState<string>("1");
  const step = planTask(study, task);
  const busy = runner.state.busy;
  const blocked = continueBlock({ study, busy, taskId: task.task_id });
  const retry = isRunStep(step) && step.action === "retry";
  // The last failure in the viewer's language (the runner's own errors are stored as data).
  const failure = isRunStep(step) && step.error ? stepErrorText(step.error) : "";
  const request = task.request;
  const remaining = allowRounds && request.kind === "reconstruct" ? Math.max(0, request.max_rounds - (searchProgress(study, task)?.decidedRounds ?? 0)) : 0;
  return (
    <div className="grid w-full gap-2">
      <p className="flex flex-wrap items-baseline gap-x-1 text-caption text-fg-secondary">
        <span className="text-fg-tertiary">{t("下一步：")}</span>
        <span>{describeStep(study, step)}</span>
      </p>
      {retry && isRunStep(step) && step.error ? (
        <p className="text-caption text-danger">
          {t("上一次失敗：{code}{value}{value2}", { code: step.error.code, value: failure ? t("：{message}", { message: failure }) : "", value2: step.error.remote_outcome_unknown ? t("（遠端結果未知：請先到執行紀錄確認，系統不會自動重送）") : "" })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {retry ? (
          <ActionButton variant="primary" size="sm" icon={<RotateCcw aria-hidden />} disabledReason={blocked} onClick={() => void runner.run(task.task_id, { mode: "step", allowRetry: true })}>
            {t("重試這一步")}
          </ActionButton>
        ) : allowRounds ? (
          <>
            <ActionButton variant="primary" size="sm" icon={<StepForward aria-hidden />} disabledReason={blocked} onClick={() => void runner.run(task.task_id, { mode: "step" })}>
              {t("執行下一步")}
            </ActionButton>
            <span className="inline-flex items-center gap-1.5">
              <label htmlFor={`${id}-rounds`} className="text-caption text-fg-secondary">
                {t("連續")}
              </label>
              <Select id={`${id}-rounds`} compact className="w-auto min-w-28" value={rounds} onChange={(event) => setRounds(event.target.value)} disabled={busy}>
                {Array.from({ length: Math.max(1, remaining) }, (_, index) => (
                  <option key={index + 1} value={String(index + 1)}>
                    {t("{index} 輪", { index: index + 1 })}
                  </option>
                ))}
                <option value="all">{t("到結束（含保留驗證）")}</option>
              </Select>
              <ActionButton
                size="sm"
                icon={<Play aria-hidden />}
                disabledReason={blocked}
                onClick={() => void runner.run(task.task_id, { mode: "loop", rounds: rounds === "all" ? "all" : Number(rounds) })}
              >
                {t("連續執行")}
              </ActionButton>
            </span>
          </>
        ) : (
          <ActionButton variant="primary" size="sm" icon={<Play aria-hidden />} disabledReason={blocked} onClick={() => void runner.run(task.task_id, { mode: "loop", rounds: "all" })}>
            {t("繼續執行")}
          </ActionButton>
        )}
        <Button size="sm" variant="quiet" icon={<CircleStop aria-hidden />} disabled={busy} title={busy ? t("執行中不能結束任務：先停止") : t("結束這個任務（結果保留）")} onClick={() => setEnding(true)}>
          {t("結束任務")}
        </Button>
      </div>
      <EndTaskDialog task={task} open={ending} onOpenChange={setEnding} onConfirm={() => void runner.end(task.task_id)} />
    </div>
  );
}
