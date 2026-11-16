// 插件管理視窗（掛在 Studio 一次，沒有自己的觸發按鈕）：鏡頭「插件」分頁的「管理插件…」與專案管理員的「插件管理…」
// 以 openPluginManager() 開啟。狀態在這裡，所以關閉再開啟仍保留分頁、篩選、選取與進行中的安裝；視窗的內容在第一次開啟
// 時才載入。每次開啟都重新讀取登錄表（別的分頁或代理工具可能剛安裝或停用了插件）。
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import type { StudioPluginId, StudioPluginInstallResult } from "@/api/generated/contracts";
import { PLUGIN_PACKAGE_EXTENSION, pluginKeys } from "@/api/plugins";
import { LazyBoundary } from "@/components/common/LazyBoundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { usePersistentChoice, usePersistentFlag } from "@/lib/usePersistentSize";
import { pluginName } from "../model/evaluate";
import { filterPlugins, PLUGIN_SORT_KEYS, sortPlugins, type PluginSortKey } from "../model/listing";
import { usePluginRegistry } from "../registry/usePluginRegistry";
import { useInstallFlow } from "./install/useInstallFlow";
import {
  ManagerContext,
  type InstalledView,
  type ManagerNotice,
  type ManagerValue,
  type NoticeTone,
  type PluginProjectBinding,
  type ProjectView,
} from "./managerContext";
import { ManagerHeader } from "./ManagerHeader";
import { closePluginManager, openPluginManager, usePluginManagerOpen, type ManagerTab } from "./managerOpen";
import { RemoveDialog } from "./RemoveDialog";
import { useDropZone } from "./useDropZone";

const ManagerWindow = lazy(() => import("./ManagerWindow"));

const TABS: readonly ManagerTab[] = ["installed", "project"];
/** 結果訊息顯示多久；安裝完成的那一列多久後收起（毫秒）。 */
const NOTICE_MS = 6000;
const DONE_MS = 5000;

type InstalledFilters = Omit<InstalledView, "sort" | "descending">;

const NO_FILTERS: InstalledFilters = { kind: "all", source: "all", query: "", selectedId: null, pane: "plugin" };
const NO_PROJECT_VIEW: ProjectView = { kind: "all", status: "all", query: "", selectedRef: null };

function installedNotice(result: StudioPluginInstallResult): string {
  const plugin = result.detail.plugin;
  const values = { name: pluginName(plugin), version: plugin.version ?? "" };
  return result.replaces ? t("已把「{name}」換成 {version}", values) : t("已安裝「{name}」{version}", values);
}

function WindowFallback() {
  return (
    <div role="status" aria-label={t("載入插件管理…")} className="grid flex-1 content-start gap-3 p-6">
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

export interface PluginManagerHostProps {
  project: PluginProjectBinding | null;
  /** Shows a result that arrives while the window is closed (an export or a removal that finished after it); without it such a result is shown the next time the window opens. */
  onNotice?: (tone: NoticeTone, text: string) => void;
}

export function PluginManagerHost({ project, onNotice }: PluginManagerHostProps) {
  const openState = usePluginManagerOpen();
  const registry = usePluginRegistry();
  const client = useQueryClient();
  const descriptionId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = usePersistentChoice<ManagerTab>("plugins.manager.tab", "installed", TABS);
  const [sort, setSort] = usePersistentChoice<PluginSortKey>("plugins.manager.sort", "name", PLUGIN_SORT_KEYS);
  const [descending, setDescending] = usePersistentFlag("plugins.manager.descending", false);
  const [filters, setFilters] = useState<InstalledFilters>(NO_FILTERS);
  const [projectView, setProjectViewState] = useState<ProjectView>(NO_PROJECT_VIEW);
  const [notice, setNotice] = useState<ManagerNotice | null>(null);
  const [removing, setRemoving] = useState<StudioPluginId | null>(null);
  const [appliedSerial, setAppliedSerial] = useState(openState.serial);
  // 以指定的項目開啟時，詳情欄要打開（視窗記得上次收起的狀態）：這個序號一變，視窗就展開詳情
  const [revealSerial, setRevealSerial] = useState(0);

  // 開啟時指定了分頁、包或貢獻：套用一次（在 render 中依開啟序號調整狀態）
  if (openState.serial !== appliedSerial) {
    setAppliedSerial(openState.serial);
    const { tab: wantedTab, ref } = openState.target;
    if (ref) {
      setTab("project");
      setProjectViewState({ ...NO_PROJECT_VIEW, selectedRef: ref });
      setRevealSerial(openState.serial);
    } else if (wantedTab) setTab(wantedTab);
  }
  // 確認框開著的時候，那個包從登錄表消失了（在別處被移除，或剛才那次移除其實完成了、只是答案沒有回來）：收起確認框並說明，
  // 之後再安裝同一個 id 也不會自己又跳出來
  if (removing !== null && registry.status === "ready" && !registry.plugins.has(removing)) {
    setRemoving(null);
    setNotice({ tone: "info", text: t("「{id}」已經不在主控上", { id: removing }), serial: (notice?.serial ?? 0) + 1 });
  }

  const openNow = useRef(openState.open);
  const outside = useRef(onNotice);
  useEffect(() => {
    openNow.current = openState.open;
    outside.current = onNotice;
  });
  const notify = useCallback((tone: NoticeTone, text: string) => {
    if (!openNow.current && outside.current) outside.current(tone, text);
    else setNotice((current) => ({ tone, text, serial: (current?.serial ?? 0) + 1 }));
  }, []);
  const onInstalled = useCallback(
    (result: StudioPluginInstallResult) => {
      setFilters((current) => ({ ...current, selectedId: result.detail.plugin.plugin_id, pane: "plugin" }));
      notify("success", installedNotice(result));
    },
    [notify],
  );
  const install = useInstallFlow({ maxBytes: registry.list?.limits.max_package_bytes ?? null, onInstalled });
  const { state: flow, dismiss, start } = install;

  // 成功與提示的訊息過一會兒自己收起；失敗的訊息留到使用者按掉（或被下一則訊息取代）
  useEffect(() => {
    if (!notice || notice.tone === "danger") return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (flow.phase !== "done") return;
    const timer = window.setTimeout(dismiss, DONE_MS);
    return () => window.clearTimeout(timer);
  }, [flow.phase, dismiss]);

  const { open } = openState;
  useEffect(() => {
    if (open) void client.invalidateQueries({ queryKey: pluginKeys.registry() });
  }, [open, client]);

  const installBlocked =
    registry.status === "loading"
      ? t("還在讀取插件登錄表")
      : registry.status === "error"
        ? t("讀不到插件登錄表")
        : registry.list?.install === "disabled"
          ? t("設定檔關閉了經 API 安裝與移除插件")
          : flow.phase === "installing"
            ? t("另一個插件包正在安裝")
            : null;

  const beginInstall = (file: File) => {
    setTab("installed");
    setFilters((current) => ({ ...current, pane: "install" }));
    start(file);
  };
  const drop = useDropZone(beginInstall, installBlocked);

  // 選取跟著清單：沒有指定、或選取的包被篩選掉時選清單的第一個（視窗一開就有內容可看）；清單是空的時沒有選取（右欄顯示空狀態）
  const visible = sortPlugins(filterPlugins(registry.list?.items ?? [], filters), sort, descending);
  const selectedId = visible.find((plugin) => plugin.plugin_id === filters.selectedId)?.plugin_id ?? visible[0]?.plugin_id ?? null;
  const value: ManagerValue = {
    registry,
    project,
    install,
    pickFile: () => fileInput.current?.click(),
    installBlocked,
    notice,
    notify,
    clearNotice: () => setNotice(null),
    installed: { ...filters, selectedId, sort, descending },
    setInstalled: (patch) => {
      const { sort: nextSort, descending: nextDescending, ...rest } = patch;
      if (nextSort !== undefined) setSort(nextSort);
      if (nextDescending !== undefined) setDescending(nextDescending);
      if (Object.keys(rest).length > 0) setFilters((current) => ({ ...current, ...rest }));
    },
    projectView,
    setProjectView: (patch) => setProjectViewState((current) => ({ ...current, ...patch })),
    showPlugin: (pluginId) => {
      setTab("installed");
      setFilters({ ...NO_FILTERS, selectedId: pluginId });
    },
    requestRemove: setRemoving,
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) openPluginManager();
        else {
          drop.reset();
          closePluginManager();
        }
      }}
    >
      <DialogContent
        aria-describedby={descriptionId}
        className="h-[min(56rem,calc(100vh-2.5rem))] max-h-none w-[calc(100vw-2.5rem)] max-w-[96rem]"
        onEscapeKeyDown={(event) => {
          // 開著的選單自己處理 Esc（關閉選單，不關視窗）
          if (document.activeElement instanceof HTMLElement && document.activeElement.closest('[role="menu"]')) event.preventDefault();
        }}
        {...drop.handlers}
      >
        <ManagerContext.Provider value={value}>
          <ManagerHeader descriptionId={descriptionId} />
          <LazyBoundary className="m-6">
            <Suspense fallback={<WindowFallback />}>
              <ManagerWindow tab={tab} onTabChange={setTab} dropping={drop.dropping} revealSerial={revealSerial} />
            </Suspense>
          </LazyBoundary>
          <input
            ref={fileInput}
            type="file"
            accept={`${PLUGIN_PACKAGE_EXTENSION},.zip,application/zip`}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file && !installBlocked) beginInstall(file);
            }}
          />
          <RemoveDialog
            pluginId={removing}
            onClose={() => setRemoving(null)}
            onRemoved={(pluginId) => setFilters((current) => (current.selectedId === pluginId ? { ...current, selectedId: null } : current))}
          />
        </ManagerContext.Provider>
      </DialogContent>
    </Dialog>
  );
}
