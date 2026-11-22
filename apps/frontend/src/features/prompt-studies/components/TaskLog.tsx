// 底部「任務」：這個研究的所有任務（新的在上）：種類、起點版本、狀態、run 數、預算用量、停止原因與最後的錯誤。
import { Link } from "react-router";
import { ListChecks } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { TimeText } from "@/components/common/values";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { runPath } from "@/app/paths";
import { imagesUsed, stopReasonText, TASK_LABELS, versionLabel, visionOpsUsed } from "../model/study";
import { taskNoteText } from "../model/taskNote";
import type { PromptStudy, PromptStudyTask } from "../types";
import { TaskStateChip } from "./shared";
import { stepErrorText } from "../model/stepError";
import { t } from "@/i18n";

export function TaskLog({ study, onOpen }: { study: PromptStudy; onOpen: (task: PromptStudyTask) => void }) {
  const tasks = [...study.tasks].reverse();
  if (tasks.length === 0) {
    return <EmptyState icon={<ListChecks />} size="compact" title={t("這個研究還沒有任務")} description={t("分析、修訂、生成比對與有界搜尋都會在這裡留下紀錄。")} />;
  }
  return (
    <TableScroll label={t("任務紀錄")} className="min-h-0 flex-1 overflow-auto">
      <Table className="min-w-[52rem] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
        <thead>
          <tr>
            <Th scope="col">{t("任務")}</Th>
            <Th scope="col">{t("起點")}</Th>
            <Th scope="col">{t("狀態")}</Th>
            <Th scope="col">{t("建立")}</Th>
            <Th scope="col" className="text-right">
              run
            </Th>
            <Th scope="col" className="text-right">
              {t("圖片／視覺")}
            </Th>
            <Th scope="col">{t("停止原因／錯誤")}</Th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const last = task.run_ids[task.run_ids.length - 1];
            // The latest step or outcome, worded in the viewer's language from the note the task stores.
            const note = taskNoteText(study, task.message);
            return (
              <Tr key={task.task_id}>
                <Td>
                  <button type="button" onClick={() => { onOpen(task); }} className="pressable group grid gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-focus" title={t("開啟對應的分頁")}>
                    <span className="text-fg group-hover:text-action-fg group-hover:underline">{TASK_LABELS[task.kind]}</span>
                    <code className="machine text-caption text-fg-tertiary">{task.task_id}</code>
                  </button>
                </Td>
                <Td className="text-fg-secondary">{(task.base_version_id != null && task.base_version_id !== "") ? versionLabel(study, task.base_version_id) : "—"}</Td>
                <Td>
                  <TaskStateChip task={task} />
                  {note ? (
                    <span className="mt-0.5 block max-w-80 truncate text-caption text-fg-tertiary" title={note}>
                      {note}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <TimeText iso={task.created_at} />
                </Td>
                <Td className="text-right">
                  <span className="machine text-fg-secondary">{task.run_ids.length}</span>
                  {(last != null && last !== "") ? (
                    <Link to={runPath(last)} className="machine block text-caption" title={t("最後一個 run：{last}", { last })}>
                      {last.slice(0, 8)}
                    </Link>
                  ) : null}
                </Td>
                <Td className="machine text-right text-fg-secondary">{t("{task}／{task2}", { task: imagesUsed(task), task2: visionOpsUsed(task) })}</Td>
                <Td className="text-caption">
                  {task.error ? (
                    <span className="text-danger" title={stepErrorText(task.error) || undefined}>
                      {`${task.error.code}${(task.error.remote_outcome_unknown === true) ? t("（遠端結果未知）") : ""}`}
                    </span>
                  ) : (
                    <span className="text-fg-tertiary">{stopReasonText(task.stop_reason)}</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
