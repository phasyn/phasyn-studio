import { isListed } from "@/lib/json";
// 「已安裝」的中欄：搜尋、排序、清單（名稱、類型、版本、狀態）。點一列就在右欄開啟詳情。狀態欄只在需要處理時出現一個詞；
// 已停用的包整列變淡。進行中的安裝是清單頂端的一列（InstallRow）。讀取中是骨架列；讀不到時說明原因並可重新讀取。
import { ArrowDownWideNarrow, ArrowUpNarrowWide, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Upload, X } from "lucide-react";
import type { StudioPlugin } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { pluginName } from "../model/evaluate";
import { defaultSortDescending, filterPlugins, kindSummary, PLUGIN_SORT_KEYS, sortLabel, sortPlugins, statusWord } from "../model/listing";
import { IssueList } from "../parts/IssueList";
import { RegistryNotice } from "../parts/RegistryNotice";
import { PluginTile } from "../parts/kinds";
import { SelectList } from "../parts/SelectList";
import { InstallRow } from "./install/InstallRow";
import type { PaneLayoutProps } from "./layout";
import { useManager } from "./managerContext";
import { ToolToggle } from "./ToolToggle";

const COLUMNS = "grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_4.5rem]";
const STATUS_TONE = { neutral: "text-fg-tertiary", warning: "text-warning", danger: "text-danger" } as const;

function PluginRow({ plugin, pending }: { plugin: StudioPlugin; pending: string | null }) {
  const status = statusWord(plugin);
  return (
    <div className={cn("grid min-h-11 items-center gap-3 px-3", COLUMNS)}>
      <span className="flex min-w-0 items-center gap-2.5">
        <PluginTile plugin={plugin} className="shadow-none" />
        <span className="truncate text-body text-fg">{pluginName(plugin)}</span>
      </span>
      <span className="truncate text-data text-fg-secondary">{kindSummary(plugin)}</span>
      <span className="machine truncate text-data text-fg-secondary">{plugin.version ?? "—"}</span>
      <span className={cn("truncate text-data font-medium", (pending != null && pending !== "") ? "text-info" : status ? STATUS_TONE[status.tone] : "")}>{pending ?? status?.word ?? ""}</span>
    </div>
  );
}

function rowTitle(plugin: StudioPlugin): string {
  return [pluginName(plugin), plugin.plugin_id, plugin.author?.name ?? ""].filter((part) => part !== "").join("\n");
}

function LoadingRows() {
  return (
    <div role="status" aria-label={t("讀取插件登錄表…")} className="grid gap-0.5 p-2">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className={cn("grid min-h-11 items-center gap-3 px-3", COLUMNS)}>
          <span className="flex items-center gap-2.5">
            <Skeleton className="size-7 shrink-0" />
            <Skeleton className="h-4 w-40" />
          </span>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-12" />
          <span />
        </div>
      ))}
    </div>
  );
}

export function PluginList({ railOpen, onToggleRail, detailOpen, onToggleDetail, onOpenDetail }: PaneLayoutProps) {
  const { registry, installed, setInstalled, install, pickFile, installBlocked } = useManager();
  const all = registry.list?.items ?? [];
  const items = sortPlugins(filterPlugins(all, installed), installed.sort, installed.descending);
  const filtered = installed.query.trim() !== "" || installed.kind !== "all" || installed.source !== "all";
  const hasUploads = all.some((plugin) => plugin.source !== "builtin");
  const flow = install.state;
  // 預覽中的包若已安裝：它的那一列標示「可更新」（或正在取代）
  const candidateId = flow.phase === "preview" || flow.phase === "installing" ? flow.result.detail.plugin.plugin_id : null;
  const candidateWord = flow.phase === "installing" ? t("更新中") : t("可更新");
  const clearFilters = () => { setInstalled({ kind: "all", source: "all", query: "" }); };
  const select = (id: string) => {
    setInstalled({ selectedId: id, pane: "plugin" });
    onOpenDetail();
  };

  return (
    <section aria-label={t("已安裝的插件")} className="flex min-h-0 min-w-0 flex-col">
      <div role="toolbar" aria-label={t("插件清單工具列")} className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <ToolToggle pressed={railOpen} label={railOpen ? t("收起篩選") : t("展開篩選")} onClick={onToggleRail}>
          {railOpen ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
        </ToolToggle>
        <div className="relative min-w-32 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            type="search"
            value={installed.query}
            aria-label={t("搜尋插件")}
            placeholder={t("搜尋名稱、作者或內容")}
            onChange={(event) => { setInstalled({ query: event.target.value }); }}
            className="pl-8"
          />
        </div>
        <Select
          compact
          aria-label={t("排序方式")}
          value={installed.sort}
          onChange={(event) => {
            const sort = event.target.value;
            if (!isListed(sort, PLUGIN_SORT_KEYS)) return;
            setInstalled({ sort, descending: defaultSortDescending(sort) });
          }}
          className="w-28"
        >
          {PLUGIN_SORT_KEYS.map((key) => (
            <option key={key} value={key}>
              {sortLabel(key)}
            </option>
          ))}
        </Select>
        <ToolToggle
          pressed={false}
          label={installed.descending ? t("由大到小（按一下改成由小到大）") : t("由小到大（按一下改成由大到小）")}
          onClick={() => { setInstalled({ descending: !installed.descending }); }}
        >
          {installed.descending ? <ArrowDownWideNarrow aria-hidden /> : <ArrowUpNarrowWide aria-hidden />}
        </ToolToggle>
        <ToolToggle pressed={detailOpen} label={detailOpen ? t("收起詳情") : t("展開詳情")} onClick={onToggleDetail}>
          {detailOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
        </ToolToggle>
      </div>

      {registry.list && registry.list.problems.length > 0 ? (
        <div className="shrink-0 border-b border-line-subtle p-2">
          <IssueList issues={registry.list.problems} label={t("插件登錄表的問題")} />
        </div>
      ) : null}
      {flow.phase !== "idle" ? <InstallRow /> : null}

      <div aria-hidden className={cn("grid h-8 shrink-0 items-center gap-3 border-b border-line-subtle bg-sunken/40 px-5 text-caption font-medium text-fg-tertiary", COLUMNS)}>
        <span>{t("名稱")}</span>
        <span>{t("類型")}</span>
        <span>{t("版本")}</span>
        <span>{t("狀態")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {registry.status === "loading" ? <LoadingRows /> : null}
        <RegistryNotice registry={registry} className="p-4" />
        {registry.status === "ready" ? (
          <>
            <SelectList
              label={t("插件")}
              items={items}
              idOf={(plugin) => plugin.plugin_id}
              selectedId={installed.pane === "plugin" ? installed.selectedId : null}
              onSelect={select}
              dimmed={(plugin) => plugin.status === "disabled"}
              titleOf={rowTitle}
              renderRow={(plugin) => <PluginRow plugin={plugin} pending={plugin.plugin_id === candidateId ? candidateWord : null} />}
              className="p-2"
            />
            {items.length === 0 && filtered ? (
              <EmptyState
                size="compact"
                icon={<Search />}
                title={t("沒有符合的插件")}
                action={
                  <Button size="sm" onClick={clearFilters} icon={<X aria-hidden />}>
                    {t("清除篩選")}
                  </Button>
                }
              />
            ) : null}
            {!hasUploads && !filtered && flow.phase === "idle" ? (
              <EmptyState
                illustration="drop"
                title={t("還沒有安裝插件")}
                description={t("把 .phasynplugin 檔拖進這個視窗，或按「安裝插件…」。")}
                action={
                  <ActionButton variant="primary" icon={<Upload aria-hidden />} disabledReason={installBlocked} onClick={pickFile}>
                    {t("安裝插件…")}
                  </ActionButton>
                }
              />
            ) : null}
          </>
        ) : null}
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-line-subtle px-3 text-caption text-fg-tertiary">
        {registry.status === "ready" ? (
          <span className="machine">{filtered ? t("{shown} / {total} 個插件", { shown: items.length, total: all.length }) : t("{total} 個插件", { total: all.length })}</span>
        ) : null}
        {filtered ? (
          <button type="button" onClick={clearFilters} className="pressable rounded-sm px-1 text-action-fg hover:underline">
            {t("清除篩選")}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
