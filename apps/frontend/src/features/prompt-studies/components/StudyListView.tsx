// 研究清單：使用中／已封存、搜尋；選取一列在檢視器看摘要與動作（開啟、封存／取消封存、刪除）。
// 網址：?view=archived、?selected=<study_id>（畫面狀態，重新整理可還原）。
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Archive, ArchiveRestore, ArrowRight, ImagePlus, RefreshCw, ScanSearch, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { IdText, TimeText } from "@/components/common/values";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/variants";
import { DockBody } from "@/components/workbench/DockPanel";
import { DocTabs } from "@/components/workbench/DocTabs";
import { EntityHeader, InspectorFooter, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { StatusChip } from "@/components/workbench/StatusChip";
import { ToolButton, ToolStrip } from "@/components/workbench/ToolStrip";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import { MEDIA_FRAME } from "@/components/ui/look";
import { SegmentedTabs } from "@/components/flow/SegmentedTabs";
import { SubBrandNav } from "@/components/flow/SubBrandNav";
import { setStudyArchived, studyKeys, useStudyList } from "../api";
import { LANGUAGE_LABELS } from "../model/sections";
import type { PromptStudySummary } from "../types";
import { CreateStudyDialog } from "./CreateStudyDialog";
import { DeleteStudyDialog } from "./DeleteStudyDialog";
import { StudyImage } from "./shared";
import { t } from "@/i18n";

function StudyStatus({ study }: { study: PromptStudySummary }) {
  if (study.archived) return <StatusChip tone="neutral" label={t("已封存")} />;
  if (study.running_task_count > 0) return <StatusChip tone="info" label={t("有未結束的任務")} />;
  if (study.version_count === 0) return <StatusChip tone="neutral" label={t("尚未分析")} />;
  return <StatusChip tone="success" label={t("已有版本")} />;
}

const countText = (value: number) => String(value);

/** 封存前的檢查（主控：有執行中的任務時不能封存）。 */
function archiveBlock(study: PromptStudySummary): string | null {
  return !study.archived && study.running_task_count > 0 ? t("有 {running_task_count} 個未結束的任務：先在研究裡完成或結束它們再封存", { running_task_count: study.running_task_count }) : null;
}

export function StudyListView() {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const list = useStudyList();
  const archivedView = params.get("view") === "archived";
  const selectedId = params.get("selected");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PromptStudySummary | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<unknown>(null);

  const items = list.data ?? [];
  const active = items.filter((item) => !item.archived);
  const archived = items.filter((item) => item.archived);
  const needle = query.trim().toLowerCase();
  const shown = (archivedView ? archived : active)
    .filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.study_id.toLowerCase().includes(needle) || item.source_name.toLowerCase().includes(needle))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const selected = items.find((item) => item.study_id === selectedId) ?? null;
  const openPath = (studyId: string) => `${location.pathname}?study=${encodeURIComponent(studyId)}`;

  const setParam = (key: string, value: string | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const toggleArchive = async (study: PromptStudySummary) => {
    if (archiving) return;
    setArchiving(study.study_id);
    setArchiveError(null);
    try {
      await setStudyArchived(study.study_id, !study.archived);
      await client.invalidateQueries({ queryKey: studyKeys.list() });
      void client.invalidateQueries({ queryKey: studyKeys.study(study.study_id) });
    } catch (error) {
      setArchiveError(error);
    } finally {
      setArchiving(null);
    }
  };

  const center = (
    <>
      <SubBrandNav current="prompt-studies" />
      <DocTabs label={t("開啟的文件")} tabs={[{ id: "list", label: t("圖片反推"), icon: ScanSearch, to: location.pathname, active: true, title: t("研究清單") }]} />
      <PageHeader
        icon={<ScanSearch />}
        title={t("圖片反推")}
        description={t("從一張圖反推可編輯的 8 區段場景 → core／detailed prompt → 生成比對與有界搜尋。誤差是機器評審的差異量，不是相似百分比，也不保證還原原始 prompt。")}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          <Button variant="primary" size="sm" icon={<ImagePlus aria-hidden />} onClick={() => setCreating(true)}>
            {t("新增研究")}
          </Button>
        }
      />
      <ToolStrip label={t("篩選研究")} role="search" className="gap-x-2.5 px-3">
        <SegmentedTabs
          tabs={[
            { id: "active", label: t("使用中"), count: list.data ? active.length : null },
            { id: "archived", label: t("已封存"), count: list.data ? archived.length : null, title: t("封存的研究保留版本、任務與圖片") },
          ]}
          value={archivedView ? "archived" : "active"}
          onChange={(next) => setParam("view", next === "archived" ? "archived" : null)}
          idPrefix="prompt-study-list"
          label={t("研究分類")}
        />
        <div className="relative min-w-40 flex-1 sm:max-w-72">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input compact type="search" value={query} placeholder={t("搜尋名稱、ID 或檔名")} aria-label={t("搜尋研究（名稱、ID、原圖檔名）")} autoComplete="off" onChange={(event) => setQuery(event.target.value)} className="pl-8" />
        </div>
        <div className="ml-auto">
          <ToolButton label={t("重新讀取研究清單")} icon={<RefreshCw aria-hidden className={list.isFetching ? "animate-spin" : undefined} />} onClick={() => void list.refetch()} />
        </div>
      </ToolStrip>
      <div role="tabpanel" id={`prompt-study-list-panel-${archivedView ? "archived" : "active"}`} aria-labelledby={`prompt-study-list-tab-${archivedView ? "archived" : "active"}`} className="flex min-h-0 flex-1 flex-col">
        {list.isError && items.length > 0 ? (
          <div className="shrink-0 border-b border-line-subtle px-4 py-2">
            <ErrorCallout error={list.error} title={t("更新失敗：顯示上一次的清單")} onRetry={() => void list.refetch()} retrying={list.isFetching} />
          </div>
        ) : null}
        {list.isPending ? (
          <div role="status" className="grid gap-2 px-4 py-5">
            <span className="sr-only">{t("讀取研究清單…")}</span>
            {[0, 1, 2, 3].map((row) => (
              <span key={row} aria-hidden className="skeleton block h-12 rounded-md bg-raised animate-shimmer" style={{ opacity: 1 - row * 0.2 }} />
            ))}
          </div>
        ) : list.isError && items.length === 0 ? (
          <div className="grid gap-3 p-4">
            <EmptyState illustration="offline" size="compact" title={t("無法讀取研究清單")} description={t("主控沒有回應或回傳錯誤；下方是完整錯誤，可以重新讀取。")} />
            <ErrorCallout error={list.error} title={t("無法讀取研究清單（/api/prompt-studies）")} onRetry={() => void list.refetch()} retrying={list.isFetching} />
          </div>
        ) : shown.length === 0 ? (
          needle ? (
            <EmptyState icon={<Search />} title={t("沒有符合的研究")} description={t("清除搜尋文字，或切換「使用中／已封存」。")} />
          ) : archivedView ? (
            <EmptyState icon={<Archive />} title={t("沒有已封存的研究")} description={t("封存的研究保留版本、任務與圖片，可以隨時取消封存。")} />
          ) : (
            <EmptyState
              illustration="frames"
              title={t("還沒有研究")}
              description={t("從一張圖片開始：上傳或從 Studio 素材庫選圖，再按「分析原圖」。")}
              action={
                <Button variant="primary" icon={<ImagePlus aria-hidden />} onClick={() => setCreating(true)}>
                  {t("新增研究")}
                </Button>
              }
            />
          )
        ) : (
          <TableScroll label={t("研究列表")} className="min-h-0 flex-1 overflow-auto">
            <Table className="min-w-[44rem] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
              <thead>
                <tr>
                  <Th scope="col" className="w-16">
                    <span className="sr-only">{t("來源圖片")}</span>
                  </Th>
                  <Th scope="col">{t("研究")}</Th>
                  <Th scope="col">{t("語言")}</Th>
                  <Th scope="col">{t("版本")}</Th>
                  <Th scope="col">{t("任務")}</Th>
                  <Th scope="col">{t("狀態")}</Th>
                  <Th scope="col">{t("更新")}</Th>
                  <Th scope="col" className="w-12">
                    <span className="sr-only">{t("開啟")}</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((study) => (
                  <Tr key={study.study_id} selected={study.study_id === selectedId} onClick={() => setParam("selected", study.study_id)} onDoubleClick={() => void navigate(openPath(study.study_id))}>
                    <Td>
                      <StudyImage file={study.source} alt={t("{value} 的來源圖片", { value: study.title || t("未命名研究") })} className="size-10 rounded-lg" fit="cover" />
                    </Td>
                    <Td>
                      <button
                        type="button"
                        className="grid min-w-0 gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-focus"
                        aria-pressed={study.study_id === selectedId}
                        onClick={(event) => {
                          event.stopPropagation();
                          setParam("selected", study.study_id);
                        }}
                      >
                        <span className="truncate font-medium text-fg">{study.title || t("未命名研究")}</span>
                        <code className="machine text-caption text-fg-tertiary">{study.study_id}</code>
                      </button>
                    </Td>
                    <Td className="text-fg-secondary">{LANGUAGE_LABELS[study.language]}</Td>
                    <Td className="machine text-fg-secondary">{countText(study.version_count)}</Td>
                    <Td className="machine text-fg-secondary">{countText(study.task_count)}</Td>
                    <Td>
                      <StudyStatus study={study} />
                    </Td>
                    <Td>
                      <TimeText iso={study.updated_at} />
                    </Td>
                    <Td>
                      <Link
                        to={openPath(study.study_id)}
                        aria-label={t("開啟研究 {value}", { value: study.title || study.study_id })}
                        title={t("開啟研究")}
                        onClick={(event) => event.stopPropagation()}
                        className={buttonVariants({ variant: "quiet", size: "icon-sm" })}
                      >
                        <ArrowRight aria-hidden />
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </div>
    </>
  );

  const inspector = selected ? (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader icon={ScanSearch} tone="info" title={selected.title || t("未命名研究")} status={<StudyStatus study={selected} />} description={LANGUAGE_LABELS[selected.language]} id={selected.study_id} />
      <DockBody>
        <PropertySection title={t("來源圖片")}>
          <div className={MEDIA_FRAME}>
            <StudyImage file={selected.source} alt={t("{value} 的來源圖片", { value: selected.title || t("未命名研究") })} className="max-h-56 w-full rounded-none border-0 bg-transparent" />
          </div>
        </PropertySection>
        <PropertySection title={t("摘要")}>
          <PropertyGrid>
            <PropertyRow label={t("原圖")}>{selected.source_name || <span className="text-fg-tertiary">—</span>}</PropertyRow>
            <PropertyRow label={t("版本")}>{countText(selected.version_count)}</PropertyRow>
            <PropertyRow label={t("任務")}>
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span>{countText(selected.task_count)}</span>
                {selected.running_task_count > 0 ? <span className="text-caption text-info">{t("· {running_task_count} 個未結束", { running_task_count: selected.running_task_count })}</span> : null}
              </span>
            </PropertyRow>
            <PropertyRow label={t("接受的版本")}>{selected.accepted_version_id ? <IdText value={selected.accepted_version_id} /> : <span className="text-fg-tertiary">{t("尚未接受")}</span>}</PropertyRow>
            <PropertyRow label={t("建立")}>
              <TimeText iso={selected.created_at} />
            </PropertyRow>
            <PropertyRow label={t("更新")}>
              <TimeText iso={selected.updated_at} />
            </PropertyRow>
            <PropertyRow label="revision" mono>
              {selected.revision}
            </PropertyRow>
          </PropertyGrid>
        </PropertySection>
        {archiveError ? (
          <div className="p-3">
            <ErrorCallout error={archiveError} write title={t("封存狀態沒有變更")} />
          </div>
        ) : null}
      </DockBody>
      <InspectorFooter note={selected.archived ? t("封存的研究可以閱讀；取消封存後才能編修與執行。") : t("封存只是從清單收起，版本、任務與圖片都保留。")}>
        <Link to={openPath(selected.study_id)} className={buttonVariants({ variant: "primary", size: "sm" })}>
          <ArrowRight aria-hidden />
          {t("開啟研究")}
        </Link>
        <ActionButton
          size="sm"
          icon={selected.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
          pending={archiving === selected.study_id}
          disabledReason={archiving === selected.study_id ? null : archiveBlock(selected)}
          onClick={() => void toggleArchive(selected)}
        >
          {selected.archived ? t("取消封存") : t("封存")}
        </ActionButton>
        <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} onClick={() => setDeleting(selected)}>
          {t("刪除…")}
        </Button>
      </InspectorFooter>
    </div>
  ) : (
    <EmptyState icon={<ScanSearch />} size="compact" title={t("選取一個研究")} description={t("在清單點一列查看摘要；按右側箭頭或「開啟研究」進入編修。")} />
  );

  return (
    <>
      <WorkbenchPage
        storageKey="inference.promptStudies.list"
        centerLabel={t("研究清單")}
        center={center}
        inspector={inspector}
        inspectorLabel={t("研究檢視器")}
        dockLabel={t("輸出面板")}
        dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> }]}
      />
      <CreateStudyDialog open={creating} onOpenChange={setCreating} onCreated={(study) => void navigate(openPath(study.study_id))} />
      <DeleteStudyDialog
        study={deleting}
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        onDeleted={() => {
          if (deleting?.study_id === selectedId) setParam("selected", null);
        }}
      />
    </>
  );
}
