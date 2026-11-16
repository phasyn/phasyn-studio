// 分頁 4：有界搜尋。初始輪生成起點版本的候選（共同搜尋 seed）→ 第 2 輪起依目前最佳誤差最高那張的前三個差異修訂 →
// 挑戰者低至少 0.05 才做 A/B 與 B/A → 輪數用完或連續沒有改善 → 保留驗證 seed 驗證目前最佳與下一個完整候選。
// 每一步都是一個明確的 run；各輪的決定不另存，由結果參照重播。
// 中欄＝預算、目前最佳、各輪細節、保留驗證、排名與比較細節；檢視器＝搜尋設定、生成設定、元件；底部是開始／繼續。
import { Telescope } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Select } from "@/components/ui/controls";
import { ToolStrip } from "@/components/workbench/ToolStrip";
import { taskSettings } from "../model/normalize";
import { findTask, versionLabel } from "../model/study";
import { TaskStateChip } from "./shared";
import type { Workspace } from "./workspace";
import { formatDateTime } from "@/i18n/format";
import { t } from "@/i18n";
import { searchTasks, type SearchController } from "./search/controller";
import { SearchTaskView } from "./search/SearchTaskView";

export function SearchCenter({ ws, search }: { ws: Workspace; search: SearchController }) {
  const tasks = searchTasks(ws);
  const task = findTask(ws.study, search.taskId) ?? tasks[0] ?? null;
  if (!task) {
    return (
      <EmptyState
        illustration="frames"
        icon={<Telescope />}
        title={t("還沒有有界搜尋")}
        description={t("在檢視器設定搜尋與保留驗證 seed、輪數與圖片預算（預設 16 張、上限 32 張、4 輪、96 次視覺操作）後開始。每一步都由你明確執行，失敗時停下來，不自動重試。")}
      />
    );
  }
  const request = task.request.kind === "reconstruct" ? task.request : null;
  return (
    <div className="grid min-w-0 content-start">
      <ToolStrip label={t("有界搜尋任務")}>
        <label htmlFor="prompt-search-task" className="text-caption text-fg-secondary">
          {t("任務")}
        </label>
        <Select id="prompt-search-task" compact className="w-auto max-w-full min-w-64" value={task.task_id} onChange={(event) => search.setTaskId(event.target.value)}>
          {tasks.map((item) => (
            <option key={item.task_id} value={item.task_id}>
              {t("{versionLabel} 起 · {created_at}", { versionLabel: versionLabel(ws.study, item.base_version_id), created_at: formatDateTime(item.created_at) })}
            </option>
          ))}
        </Select>
        <TaskStateChip task={task} />
      </ToolStrip>
      {request ? (
        <SearchTaskView ws={ws} search={search} task={task} request={request} settings={taskSettings(request.settings)} />
      ) : (
        <p className="p-4 text-data text-warning">{t("這個任務的設定無法解讀，不能繼續；結果參照仍保留在研究文件中。")}</p>
      )}
    </div>
  );
}

export { SearchInspector } from "./search/SearchInspector";

export type { SearchController } from "./search/controller";
