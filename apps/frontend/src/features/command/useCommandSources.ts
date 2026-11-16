// 命令面板的資料來源：靜態頁面＋目錄元件＋元件組合＋run（列表第一頁）＋專案（Image／Video Studio 共用）＋最近開啟。
// 這些 hooks 不接受 enabled，所以只由面板內容呼叫（DialogContent 關閉時卸載＝不讀取）；
// 沿用既有 query key 與快取，不另外加輪詢。每個來源的讀取中／失敗各自回報，不阻擋其他群組。
import { useMemo } from "react";
import { useLocation } from "react-router";
import { useCatalog } from "@/api/catalog";
import { usePipelines } from "@/api/pipelines";
import { useRunList } from "@/api/runs";
import { useStudioProjects } from "@/api/studioProjects";
import { getLocale } from "@/i18n";
import { toErrorInfo } from "@/lib/errors";
import { createPersistentStore } from "@/lib/persistentStore";
import { componentItems, GROUP_LABELS, localeActionItems, pageItems, pipelineItems, projectItems, runItems, type CommandItem, type CommandKind } from "./model/items";
import { openProjectOf } from "./model/navigation";
import { addRecent, parseRecents, RECENTS_KEY, recentEntryOf, type RecentEntry } from "./model/recents";

export type SourceKind = Exclude<CommandKind, "page" | "action">;

export interface SourceIssue {
  kind: SourceKind;
  /** 群組名稱（元件、元件組合…）。 */
  label: string;
  /** loading＝第一次讀取中；error＝讀取失敗且沒有資料（已略過）；stale＝最近一次讀取失敗，顯示的是舊資料。 */
  state: "loading" | "error" | "stale";
  message: string | null;
  retry: () => void;
}

export interface CommandSources {
  items: CommandItem[];
  recents: RecentEntry[];
  issues: SourceIssue[];
}

interface QueryState {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
}

function issueOf(kind: SourceKind, query: QueryState, retry: () => void): SourceIssue | null {
  const label = GROUP_LABELS[kind];
  if (query.isError) {
    return { kind, label, state: query.data === undefined ? "error" : "stale", message: toErrorInfo(query.error).message || null, retry };
  }
  if (query.isPending) return { kind, label, state: "loading", message: null, retry };
  return null;
}

export function useCommandSources(): CommandSources {
  const catalog = useCatalog();
  const pipelines = usePipelines();
  const runs = useRunList();
  const projects = useStudioProjects();
  const recents = useRecents();
  const location = useLocation();
  const openProject = openProjectOf(location.pathname, location.search);

  const runPage = runs.data?.pages[0]?.items;
  const items = useMemo(
    () => [
      ...pageItems(openProject),
      ...componentItems(catalog.data),
      ...pipelineItems(pipelines.data?.items),
      ...runItems(runPage),
      ...projectItems(projects.data?.items),
      ...localeActionItems(getLocale()),
    ],
    [openProject, catalog.data, pipelines.data, runPage, projects.data],
  );

  const issues = [
    issueOf("component", catalog, () => void catalog.refetch()),
    issueOf("pipeline", pipelines, () => void pipelines.refetch()),
    issueOf("run", runs, () => void runs.refetch()),
    issueOf("project", projects, () => void projects.refetch()),
  ].filter((issue): issue is SourceIssue => issue !== null);

  return { items, recents, issues };
}

// ── 最近開啟：這台瀏覽器的便利狀態（localStorage），跨分頁同步；不可用時只留在記憶體 ──

const recentsStore = createPersistentStore<RecentEntry[]>({ key: RECENTS_KEY, initial: [], parse: parseRecents });

export function useRecents(): RecentEntry[] {
  return recentsStore.use();
}

/** 記下剛開啟的項目（最前面、依 to 去重、最多 8 筆）；storage 寫入失敗時仍保留在記憶體。 */
export function rememberRecent(item: CommandItem): void {
  recentsStore.set((current) => addRecent(current, recentEntryOf(item, Date.now())));
}
