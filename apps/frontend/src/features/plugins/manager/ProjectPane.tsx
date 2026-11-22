// 「這個專案」分頁：這個專案選用了哪些插件貢獻（依選取順序），以及還可以加入哪些。左欄依種類與狀態篩選，中欄是清單
// （每列一個開關；推薦組合一鍵套用），右欄是選取項目的可讀預覽。專案引用了登錄表裡沒有的貢獻時顯示「找不到」，動作是
// 「移除引用」；所屬的包停用或不相容時顯示原因。這裡的每個變更都是一般的專案編輯（會自動保存），不會動到主控上的包。
import { CircleAlert, CircleCheck, LayoutGrid, PackageSearch, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Unlink, X } from "lucide-react";
import type { StudioPluginRef } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  CONTRIBUTION_KINDS,
  contributionKindLabel,
  countContributionKinds,
  filterContributions,
  listContributions,
  selectedItems,
  type Contribution,
  type ContributionKindFilter,
  type SelectedItem,
} from "../model/contributions";
import { pluginName } from "../model/evaluate";
import { pluginUsable, registryLimits } from "../model/registry";
import { addCheck, replaceNote, withoutRef, withRef } from "../model/selection";
import { KIND_ICON } from "../parts/kindIcons";
import { ContributionIcon } from "../parts/kinds";
import { RegistryNotice } from "../parts/RegistryNotice";
import { useSlideIn } from "../parts/motion";
import { GenerationPreview, RulePreview } from "../parts/RulePreview";
import { SelectList } from "../parts/SelectList";
import { ToggleSwitch } from "../parts/ToggleSwitch";
import { PresetButtons } from "../use/PresetButtons";
import { FilterRail, RailSection } from "./FilterRail";
import { paneColumns, type PaneLayoutProps } from "./layout";
import { useManager, type PluginProjectBinding, type ProjectStatusFilter } from "./managerContext";
import { ToolToggle } from "./ToolToggle";

/** 清單的一列：選用中的引用（可能找不到），或登錄表裡還沒選用的貢獻。 */
interface Row {
  ref: StudioPluginRef;
  contribution: Contribution | null;
  active: boolean;
  problem: string | null;
}

function buildRows(selected: readonly SelectedItem[], available: readonly Contribution[]): Row[] {
  const active = new Set(selected.map((item) => item.ref));
  return [
    ...selected.map((item) => ({ ref: item.ref, contribution: item.contribution, active: true, problem: item.problem?.text ?? null })),
    ...available.filter((item) => !active.has(item.ref)).map((item) => ({ ref: item.ref, contribution: item, active: false, problem: null })),
  ];
}

function matches(row: Row, kind: ContributionKindFilter, status: ProjectStatusFilter, query: string): boolean {
  if (status === "active" && !row.active) return false;
  if (status === "attention" && row.problem === null) return false;
  if (!row.contribution) return kind === "all" && (query.trim() === "" || row.ref.includes(query.trim().toLocaleLowerCase()));
  return filterContributions([row.contribution], kind, query).length > 0;
}

function RowView({ row, project }: { row: Row; project: PluginProjectBinding }) {
  const { registry } = useManager();
  const label = row.contribution?.label ?? row.ref;
  const check = row.active ? { reason: null, replaces: null } : addCheck(registry, project.refs, row.ref);
  const name = row.active ? t("這個專案正在使用「{label}」", { label }) : t("在這個專案使用「{label}」", { label });
  return (
    <div className="flex min-h-11 items-center gap-2.5 pr-1 pl-3">
      {row.contribution ? <ContributionIcon kind={row.contribution.kind} /> : <CircleAlert aria-hidden className="size-4 shrink-0 text-warning" />}
      <span className={cn("min-w-0 flex-1 truncate text-body", row.contribution ? "text-fg" : "machine text-fg-secondary")}>{label}</span>
      {(row.problem != null && row.problem !== "") ? (
        <span className="shrink-0 text-data font-medium text-warning">{row.contribution ? t("需要處理") : t("找不到")}</span>
      ) : (
        <span className="hidden min-w-0 shrink truncate text-caption text-fg-tertiary @min-[30rem]/list:inline">{row.contribution ? pluginName(row.contribution.plugin) : ""}</span>
      )}
      <ToggleSwitch
        checked={row.active}
        label={(check.replaces != null && check.replaces !== "") ? `${name}\n${replaceNote(registry, check.replaces)}` : name}
        disabledReason={check.reason}
        onChange={(next) => { project.onRefsChange(next ? withRef(registry, project.refs, row.ref) : withoutRef(project.refs, row.ref)); }}
      />
    </div>
  );
}

function PresetBar({ project }: { project: PluginProjectBinding }) {
  const { registry, notify } = useManager();
  if (!registry.presets.some((preset) => pluginUsable(preset.plugin))) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line-subtle px-3 py-2">
      <span aria-hidden className="shrink-0 text-caption font-semibold text-fg-tertiary">
        {t("推薦組合")}
      </span>
      <PresetButtons
        registry={registry}
        refs={project.refs}
        onChange={project.onRefsChange}
        onApplied={(label) => { notify("success", t("這個專案已套用「{label}」", { label })); }}
        className="flex-nowrap"
      />
    </div>
  );
}

function RowDetail({ row, project }: { row: Row; project: PluginProjectBinding }) {
  const { registry, showPlugin } = useManager();
  const slideIn = useSlideIn<HTMLDivElement>();
  const item = row.contribution;
  const check = row.active ? { reason: null, replaces: null } : addCheck(registry, project.refs, row.ref);
  return (
    <div ref={slideIn} className="flex min-h-0 flex-1 flex-col">
      <header className="grid shrink-0 gap-3 border-b border-line-subtle px-4 pt-4 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-raised [&_svg]:size-5", item ? "" : "border-warning/40 text-warning")}>
            {item ? <ContributionIcon kind={item.kind} className="size-5" /> : <CircleAlert />}
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <h3 title={item?.label ?? row.ref} className={cn("truncate text-section font-semibold text-fg", !item && "machine")}>
              {item?.label ?? row.ref}
            </h3>
            <p className="truncate text-caption text-fg-tertiary">{item ? t("{kind}・來自「{plugin}」", { kind: contributionKindLabel(item.kind), plugin: pluginName(item.plugin) }) : t("登錄表裡沒有這個項目")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {row.active ? (
            <ActionButton variant="secondary" icon={item ? <X aria-hidden /> : <Unlink aria-hidden />} onClick={() => { project.onRefsChange(withoutRef(project.refs, row.ref)); }}>
              {item ? t("從這個專案移除") : t("移除引用")}
            </ActionButton>
          ) : (
            <ActionButton
              variant="primary"
              icon={<CircleCheck aria-hidden />}
              disabledReason={check.reason}
              title={(check.replaces != null && check.replaces !== "") ? replaceNote(registry, check.replaces) : undefined}
              onClick={() => { project.onRefsChange(withRef(registry, project.refs, row.ref)); }}
            >
              {t("在這個專案使用")}
            </ActionButton>
          )}
          {item ? (
            <Button variant="secondary" icon={<PackageSearch aria-hidden />} onClick={() => { showPlugin(item.plugin.plugin_id); }}>
              {t("查看插件")}
            </Button>
          ) : null}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4">
        {(row.problem != null && row.problem !== "") ? <Callout tone="warning" title={row.problem} /> : null}
        {item?.rule ? <RulePreview rule={item.rule.rule} /> : null}
        {item?.generation ? <GenerationPreview generation={item.generation.generation} /> : null}
      </div>
    </div>
  );
}

export function ProjectPane({ project, railOpen, onToggleRail, detailOpen, onToggleDetail, onOpenDetail }: PaneLayoutProps & { project: PluginProjectBinding }) {
  const { registry, projectView, setProjectView } = useManager();
  const available = listContributions(registry);
  const all = buildRows(selectedItems(registry, project.refs), available);
  const rows = all.filter((row) => matches(row, projectView.kind, projectView.status, projectView.query));
  // 被篩選掉的項目不留在右欄（右欄顯示空狀態，清掉篩選後再出現）
  const selected = rows.find((row) => row.ref === projectView.selectedRef) ?? null;
  const counts = countContributionKinds(all.flatMap((row) => (row.contribution ? [row.contribution] : [])));
  const activeCount = all.filter((row) => row.active).length;
  const attention = all.filter((row) => row.problem !== null).length;
  const limit = registryLimits(registry)?.max_project_plugins ?? null;
  const filtered = projectView.kind !== "all" || projectView.status !== "all" || projectView.query.trim() !== "";
  const clearFilters = () => { setProjectView({ kind: "all", status: "all", query: "" }); };
  return (
    <div className={cn("grid min-h-0 flex-1", paneColumns(railOpen, detailOpen))}>
      {railOpen ? (
        <FilterRail label={t("篩選")}>
          <RailSection
            group={{
              id: "contribution-kind",
              title: t("種類"),
              value: projectView.kind,
              onChange: (kind) => { setProjectView({ kind }); },
              options: [
                // 「全部」也列出找不到的引用（它們沒有種類），所以數的是清單的列數
                { id: "all", label: t("全部"), icon: LayoutGrid, count: all.length },
                ...CONTRIBUTION_KINDS.map((kind) => ({ id: kind, label: contributionKindLabel(kind), icon: KIND_ICON[kind], count: counts[kind] })),
              ],
            }}
          />
          <RailSection
            group={{
              id: "contribution-status",
              title: t("狀態"),
              value: projectView.status,
              onChange: (status) => { setProjectView({ status }); },
              options: [
                { id: "all", label: t("全部"), icon: LayoutGrid, count: all.length },
                { id: "active", label: t("套用中"), icon: CircleCheck, count: activeCount },
                { id: "attention", label: t("需要處理"), icon: CircleAlert, count: attention },
              ],
            }}
          />
        </FilterRail>
      ) : null}

      <section aria-label={t("這個專案的插件項目")} className="@container/list flex min-h-0 min-w-0 flex-col">
        <div role="toolbar" aria-label={t("項目清單工具列")} className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
          <ToolToggle pressed={railOpen} label={railOpen ? t("收起篩選") : t("展開篩選")} onClick={onToggleRail}>
            {railOpen ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
          </ToolToggle>
          <div className="relative min-w-32 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
            <Input
              compact
              type="search"
              value={projectView.query}
              aria-label={t("搜尋項目")}
              placeholder={t("搜尋名稱、說明或插件")}
              onChange={(event) => { setProjectView({ query: event.target.value }); }}
              className="pl-8"
            />
          </div>
          <span className="machine shrink-0 text-data text-fg-secondary" title={limit === null ? undefined : t("一個專案最多選 {limit} 個插件項目", { limit })}>
            {limit === null ? t("套用 {count}", { count: activeCount }) : t("套用 {count} / {limit}", { count: activeCount, limit })}
          </span>
          <ToolToggle pressed={detailOpen} label={detailOpen ? t("收起詳情") : t("展開詳情")} onClick={onToggleDetail}>
            {detailOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
          </ToolToggle>
        </div>
        <PresetBar project={project} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {registry.status === "loading" ? (
            <div role="status" aria-label={t("讀取插件登錄表…")} className="grid gap-2 p-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : null}
          <RegistryNotice registry={registry} className="p-4" />
          <SelectList
            label={t("插件項目")}
            items={rows}
            idOf={(row) => row.ref}
            selectedId={projectView.selectedRef}
            onSelect={(ref) => {
              setProjectView({ selectedRef: ref });
              onOpenDetail();
            }}
            titleOf={(row) => [row.contribution?.label ?? row.ref, row.problem ?? row.contribution?.description ?? ""].filter(Boolean).join("\n")}
            renderRow={(row) => <RowView row={row} project={project} />}
            groupOf={(row) => (row.active ? t("套用中") : t("可以加入"))}
            className="p-2"
          />
          {rows.length === 0 && registry.status === "ready" ? (
            <EmptyState
              size="compact"
              icon={<Search />}
              title={filtered ? t("沒有符合的項目") : t("還沒有可以選用的插件項目")}
              action={
                filtered ? (
                  <Button size="sm" onClick={clearFilters} icon={<X aria-hidden />}>
                    {t("清除篩選")}
                  </Button>
                ) : undefined
              }
            />
          ) : null}
        </div>
      </section>

      {detailOpen ? (
        <aside aria-label={t("項目詳情")} className="flex min-h-0 min-w-0 flex-col border-l border-line-subtle bg-canvas/40">
          {selected ? (
            <RowDetail key={selected.ref} row={selected} project={project} />
          ) : (
            <div className="grid flex-1 place-items-center">
              <EmptyState size="compact" icon={<PackageSearch />} title={t("選一個項目查看內容")} />
            </div>
          )}
        </aside>
      ) : null}
    </div>
  );
}
