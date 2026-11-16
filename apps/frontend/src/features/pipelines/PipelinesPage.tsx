import { Activity, ArrowDown, ArrowUp, FilePlus, Folder, Inbox, LayoutTemplate, LoaderCircle, SearchX, TriangleAlert, Workflow, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useCatalog } from "@/api/catalog";
import { qk } from "@/api/keys";
import { isNotFound, usePipeline } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { AreaIcon } from "@/components/common/AreaIcon";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { useFlipList, reveal } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { DocTabs, type DocTab } from "@/components/workbench/DocTabs";
import { DockBody } from "@/components/workbench/DockPanel";
import { providerKind } from "@/components/workbench/kinds";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { TEXT_TONE } from "@/components/workbench/tones";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { cn } from "@/lib/cn";
import { uniqueName } from "@/lib/ids";
import { isRecord } from "@/lib/json";
import { ActivityLog } from "@/features/activity";
import { makeLookup } from "./catalogIndex";
import { describeLocation, layoutSections, locatePipeline, movePipelineToGroup, stepPipeline, UNGROUPED_LABEL, type GroupKey, type LayoutContent, type PipelineLocation } from "./layoutModel";
import { LAYOUT_UNSUPPORTED } from "./layoutMessages";
import { readListNotice } from "./listNotice";
import { PipelineEditor } from "./PipelineEditor";
import { emptyPipeline } from "./pipelineModel";
import { TemplateDialog } from "./TemplateDialog";
import { usePipelineLayoutEditor, type PipelineLayoutEditor } from "./usePipelineLayoutEditor";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

interface NewDraftState {
  draft: WirePipeline;
  unresolved?: string[];
}

function readDraftState(state: unknown): NewDraftState | null {
  if (!isRecord(state) || !isRecord(state.draft)) return null;
  const draft = state.draft as unknown as WirePipeline;
  if (typeof draft.pipeline_id !== "string" || !Array.isArray(draft.steps)) return null;
  const unresolved = Array.isArray(state.unresolved) ? state.unresolved.filter((item): item is string => typeof item === "string") : [];
  return { draft, unresolved };
}

/** 第一次讀取：狀態文字＋幾列骨架（shimmer 掃過）。 */
function LoadingRows({ label, rows = 5, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div role="status" className={cn("grid content-start gap-2 px-4 py-4", className)}>
      <p className="text-data text-fg-secondary">{label}</p>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden className="skeleton h-7 animate-shimmer" style={{ opacity: 1 - index * 0.15 }} />
      ))}
    </div>
  );
}

function EditorMessage({ tabs, children }: { tabs: readonly DocTab[]; children: ReactNode }) {
  return (
    <WorkbenchPage
      storageKey="admin.pipeline"
      centerLabel={t("元件組合編輯器")}
      center={
        <>
          <DocTabs label={t("開啟的文件")} tabs={tabs} />
          <PageHeader icon={<Workflow />} title={t("元件組合")} className="shrink-0 border-b border-line-subtle px-4 py-3" />
          <DockBody className="p-4">{children}</DockBody>
        </>
      }
    />
  );
}

/**
 * 開啟已保存的元件組合。伺服器回 NOT_FOUND（例如在其他視窗已刪除）：不顯示舊快取，
 * 同時讓清單快取重新讀取，左欄與清單不會再列出它。
 */
function SavedPipeline({
  pipelineId,
  existingIds,
  tabs,
  listed,
}: {
  pipelineId: string;
  existingIds: ReadonlySet<string>;
  tabs: readonly DocTab[];
  /** 最新的清單是否還有這個元件組合（清單尚未讀到＝null）。 */
  listed: boolean | null;
}) {
  const query = usePipeline(pipelineId);
  const client = useQueryClient();
  const missing = query.isError && isNotFound(query.error);
  useEffect(() => {
    if (missing) void client.invalidateQueries({ queryKey: qk.pipelines() });
  }, [missing, client]);
  if (query.isPending) {
    return (
      <EditorMessage tabs={tabs}>
        <LoadingRows label={t("讀取元件組合 {pipelineId}…", { pipelineId })} rows={3} className="p-0" />
      </EditorMessage>
    );
  }
  if (missing) {
    return (
      <EditorMessage tabs={tabs}>
        <EmptyState
          icon={<SearchX />}
          title={t("這個元件組合已不存在")}
          description={
            <>
              <T source={"主控上沒有 <0>{pipelineId}</0>：可能已在其他視窗或分頁刪除。已建立的 run 仍保有各自的副本。"} values={{ pipelineId }} slots={[<code className="machine" />]} />
            </>
          }
          action={
            <Link to="/admin/pipelines" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("回到元件組合清單")}
            </Link>
          }
        />
      </EditorMessage>
    );
  }
  if (query.isError) {
    return (
      <EditorMessage tabs={tabs}>
        <ErrorCallout error={query.error} title={t("無法讀取元件組合")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </EditorMessage>
    );
  }
  return (
    <PipelineEditor
      key={pipelineId}
      initial={query.data}
      isNew={false}
      existingIds={existingIds}
      tabs={tabs}
      notice={
        listed === false ? (
          <Callout tone="warning" title={t("主控的清單上已沒有這個元件組合")}>
            <p>{t("可能已在其他視窗或分頁刪除。這裡的草稿仍保留；按「儲存元件組合」會以同一個 ID 重新建立它，不想保留就關閉這個分頁。")}</p>
          </Callout>
        ) : null
      }
    />
  );
}

const LIST_TAB: DocTab = { id: "pipelines", label: t("元件組合"), icon: Workflow, to: "/admin/pipelines", active: false, title: t("已保存的元件組合") };

/** 移到分類的下拉選單用的值：未分類（不是合法的本地 ID，不會和 group_id 相同）。 */
const UNGROUPED_VALUE = "__ungrouped__";
const COLUMNS = 6;

/** 一個元件組合的列：名稱、ID、步驟用到的元件類型、輸入／輸出數，以及上移／下移與移到分類。 */
function PipelineRow({
  pipeline,
  lookup,
  editor,
  content,
  appear,
}: {
  pipeline: WirePipeline;
  lookup: ReturnType<typeof makeLookup>;
  editor: PipelineLayoutEditor;
  content: LayoutContent | null;
  /** 在分類內的順序（第一次出現時依序淡入）。 */
  appear: number;
}) {
  const name = pipeline.label || pipeline.pipeline_id;
  const where = content ? locatePipeline(content, pipeline.pipeline_id) : null;
  const up = content ? stepPipeline(content, pipeline.pipeline_id, -1) : null;
  const down = content ? stepPipeline(content, pipeline.pipeline_id, 1) : null;
  const blocked = editor.blockedReason;

  const apply = (result: { layout: LayoutContent; location: PipelineLocation } | null, control: string) => {
    if (!result) return;
    editor.commit(result.layout, t("「{name}」已移到{layout}", { name, layout: describeLocation(result.layout, result.location) }));
    // 列換了位置會失去焦點：下一個畫面聚焦回同一個控制項
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-pipeline-row="${CSS.escape(pipeline.pipeline_id)}"] [data-layout-control="${control}"]`)?.focus(),
    );
  };

  return (
    <Tr data-pipeline-row={pipeline.pipeline_id} ref={reveal(appear)}>
      <Td>
        <Link
          to={`/admin/pipelines/${encodeURIComponent(pipeline.pipeline_id)}`}
          className="group/name flex min-w-0 items-center gap-2 rounded-sm no-underline hover:underline focus-visible:underline"
        >
          <Workflow aria-hidden className="size-4 shrink-0 text-fg-tertiary transition-colors duration-(--duration-fast) group-hover/name:text-action-fg" />
          <span className="[overflow-wrap:anywhere]">{name}</span>
        </Link>
      </Td>
      <Td className="machine text-fg-secondary">{pipeline.pipeline_id}</Td>
      <Td>
        <span className="flex flex-wrap items-center gap-1" aria-label={t("{stepsCount} 個步驟", { stepsCount: pipeline.steps.length })}>
          {pipeline.steps.map((step) => {
            const descriptor = lookup(step.node_id, step.component_id);
            const kind = providerKind(descriptor?.provider_id);
            return (
              <span
                key={step.step_id}
                title={`${step.step_id} · ${step.component_id || t("未選 instance")}${descriptor ? "" : t("（未知元件）")}`}
                className={cn("inline-flex items-center gap-1 rounded-full border bg-sunken px-2 text-caption", descriptor ? "border-line-subtle" : "border-dashed border-warning/50")}
              >
                <kind.icon aria-hidden className={cn("size-3.5", TEXT_TONE[kind.tone])} />
                <code className="machine text-fg-secondary">{step.step_id}</code>
              </span>
            );
          })}
        </span>
      </Td>
      <Td className="machine text-fg-secondary">{pipeline.inputs.length}</Td>
      <Td className="machine text-fg-secondary">{Object.keys(pipeline.outputs).length}</Td>
      <Td className="py-1.5">
        {content ? (
          <div className="flex items-center gap-1">
            <ToolButton
              data-layout-control="up"
              label={t("上移「{name}」", { name })}
              icon={<ArrowUp aria-hidden />}
              disabledReason={blocked ?? (up ? null : t("已經在最上面"))}
              onClick={() => apply(up, "up")}
            />
            <ToolButton
              data-layout-control="down"
              label={t("下移「{name}」", { name })}
              icon={<ArrowDown aria-hidden />}
              disabledReason={blocked ?? (down ? null : t("已經在最下面"))}
              onClick={() => apply(down, "down")}
            />
            <Select
              compact
              data-layout-control="group"
              aria-label={t("「{name}」的分類（選擇後移到該分類最後）", { name })}
              title={blocked ?? t("選擇分類：移到該分類最後")}
              disabled={Boolean(blocked)}
              value={where?.group ?? UNGROUPED_VALUE}
              onChange={(event) => {
                const key: GroupKey = event.target.value === UNGROUPED_VALUE ? null : event.target.value;
                apply(movePipelineToGroup(content, pipeline.pipeline_id, key), "group");
              }}
              className="w-36"
            >
              {content.groups.map((group) => (
                <option key={group.group_id} value={group.group_id}>
                  {group.name}
                </option>
              ))}
              <option value={UNGROUPED_VALUE}>{UNGROUPED_LABEL}</option>
            </Select>
          </div>
        ) : (
          <span className="text-caption text-fg-tertiary">{blocked ?? "—"}</span>
        )}
      </Td>
    </Tr>
  );
}

/** 一個分類的 tbody：上移／下移或移到分類後，其他列從舊位置平滑移到新位置（FLIP，只用 transform）。 */
function SectionBody({ order, children }: { order: string; children: ReactNode }) {
  const ref = useRef<HTMLTableSectionElement>(null);
  useFlipList(ref, order);
  return <tbody ref={ref}>{children}</tbody>;
}

/** 已保存元件組合的表格：依分類分組（分類依序，最後是未分類）；沒有分類資料時依清單順序。 */
function PipelineTable({ editor }: { editor: PipelineLayoutEditor }) {
  const catalog = useCatalog();
  const lookup = makeLookup(catalog.data);
  const items = editor.pipelines.data?.items ?? [];
  const content = editor.content;
  const sections = content ? layoutSections(content, items) : null;
  const row = (pipeline: WirePipeline, index: number) => (
    <PipelineRow key={pipeline.pipeline_id} pipeline={pipeline} lookup={lookup} editor={editor} content={content} appear={index} />
  );
  const orderOf = (list: readonly WirePipeline[]) => list.map((pipeline) => pipeline.pipeline_id).join("␟");
  return (
    <TableScroll label={t("已保存的元件組合")} className="min-h-0 flex-1 overflow-auto">
      <Table className="min-w-[52rem] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
        <thead>
          <tr>
            <Th scope="col">{t("名稱")}</Th>
            <Th scope="col">pipeline_id</Th>
            <Th scope="col">{t("步驟")}</Th>
            <Th scope="col">{t("輸入")}</Th>
            <Th scope="col">{t("輸出")}</Th>
            <Th scope="col">{t("順序與分類")}</Th>
          </tr>
        </thead>
        {sections ? (
          sections.map((section) => {
            const Icon = section.key === null ? Inbox : Folder;
            return (
              <SectionBody key={section.key ?? UNGROUPED_VALUE} order={orderOf(section.items)}>
                <tr>
                  <th scope="rowgroup" colSpan={COLUMNS} className="border-b border-line-subtle bg-canvas px-4 py-1.5 text-left text-caption font-semibold text-fg-secondary">
                    <span className="flex items-center gap-1.5">
                      <Icon aria-hidden className="size-4 text-fg-tertiary" />
                      {section.name}
                      <span className="machine font-normal text-fg-tertiary">{section.items.length}</span>
                    </span>
                  </th>
                </tr>
                {section.items.length === 0 ? (
                  <tr>
                    <Td colSpan={COLUMNS} className="text-caption text-fg-tertiary">
                      {section.key === null ? t("所有元件組合都已分類。") : t("這個分類還沒有元件組合：用「順序與分類」欄的選單，或在左欄拖曳放進來。")}
                    </Td>
                  </tr>
                ) : (
                  section.items.map(row)
                )}
              </SectionBody>
            );
          })
        ) : (
          <SectionBody order={orderOf(items)}>{items.map(row)}</SectionBody>
        )}
      </Table>
    </TableScroll>
  );
}

/** 分類與排序的狀態：保存中、保存失敗（已還原）、無法讀取（依清單順序顯示，不能調整）。 */
function LayoutStatus({ editor }: { editor: PipelineLayoutEditor }) {
  const unsupported = !editor.layout.data && isNotFound(editor.layout.error);
  return (
    <>
      {editor.saving ? (
        // 立即回饋：保存中的文字＋底部一條不定進度的光帶（沒有百分比可報，不顯示數字）
        <div className="relative shrink-0 border-b border-line-subtle px-4 py-1.5 text-caption text-fg-tertiary animate-fade-in">
          <p className="flex items-center gap-1.5">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            {t("正在保存分類與排序…")}
          </p>
          <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-brand-gradient-soft animate-shimmer" />
        </div>
      ) : null}
      {editor.error ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-line-subtle bg-sunken px-4 py-2 text-data text-fg-secondary animate-rise-in">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{editor.error}</span>
          <ToolButton label={t("關閉這則訊息")} icon={<X aria-hidden />} onClick={editor.dismissError} className="-my-1" />
        </div>
      ) : null}
      {unsupported ? (
        <Callout tone="info" title={t("依 pipeline_id 排序顯示")} className="m-4 mb-0 shrink-0">
          <p>{t("{layoutUnsupported}；更新後即可建立分類並調整順序。", { layoutUnsupported: LAYOUT_UNSUPPORTED })}</p>
        </Callout>
      ) : editor.layout.isError && !editor.layout.data ? (
        <div className="m-4 mb-0 shrink-0">
          <ErrorCallout error={editor.layout.error} title={t("無法讀取分類與排序（依清單順序顯示，暫時不能調整）")} onRetry={() => void editor.layout.refetch()} retrying={editor.layout.isFetching} />
        </div>
      ) : null}
    </>
  );
}

/** 元件組合頁：已保存的元件組合清單；開啟或新建時進入編輯器。範本只建立可編輯草稿。 */
export function PipelinesPage() {
  const { pipelineId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const editor = usePipelineLayoutEditor();
  const list = editor.pipelines;
  const [templateOpen, setTemplateOpen] = useState(false);
  const isNew = location.pathname.replace(/\/+$/, "") === "/admin/pipelines/new";
  const existingIds = new Set(list.data?.items.map((item) => item.pipeline_id) ?? []);
  const newState = isNew ? readDraftState(location.state) : null;

  const openDraft = (draft: WirePipeline, unresolved: string[] = []) => {
    void navigate("/admin/pipelines/new", { state: { draft, unresolved } satisfies NewDraftState });
  };
  const createActions = (
    <>
      <Button size="sm" icon={<FilePlus aria-hidden />} onClick={() => openDraft(emptyPipeline(uniqueName("pipeline", existingIds), t("新元件組合")))}>
        {t("新增空白元件組合")}
      </Button>
      <Button size="sm" variant="primary" icon={<LayoutTemplate aria-hidden />} onClick={() => setTemplateOpen(true)}>
        {t("從範本建立")}
      </Button>
    </>
  );
  const dialog = (
    <TemplateDialog
      open={templateOpen}
      onOpenChange={setTemplateOpen}
      existingIds={existingIds}
      onCreate={(draft, unresolved) => {
        setTemplateOpen(false);
        openDraft(draft, unresolved);
      }}
    />
  );

  if (isNew || pipelineId) {
    const open: DocTab = isNew
      ? { id: "new", label: newState?.draft.label || t("新元件組合"), icon: Workflow, iconTone: "action", to: location.pathname, active: true, closeTo: "/admin/pipelines" }
      : { id: pipelineId ?? "", label: list.data?.items.find((item) => item.pipeline_id === pipelineId)?.label || pipelineId || "", icon: Workflow, iconTone: "action", to: location.pathname, active: true, closeTo: "/admin/pipelines" };
    const tabs = [LIST_TAB, open];
    return (
      <>
        {isNew ? (
          <PipelineEditor
            key={location.key}
            initial={newState?.draft ?? emptyPipeline(uniqueName("pipeline", existingIds), t("新元件組合"))}
            isNew
            existingIds={existingIds}
            tabs={tabs}
            notice={
              newState?.unresolved && newState.unresolved.length > 0 ? (
                <Callout tone="warning" title={t("範本有無法自動接線的必填輸入")}>
                  <p>
                    <T source={"{span}：請在「步驟與接線」中選擇來源。"} values={{ span: <span className="machine">{formatList(newState.unresolved)}</span> }} />
                  </p>
                </Callout>
              ) : null
            }
          />
        ) : (
          <SavedPipeline pipelineId={pipelineId ?? ""} existingIds={existingIds} tabs={tabs} listed={list.data ? existingIds.has(pipelineId ?? "") : null} />
        )}
        {dialog}
      </>
    );
  }

  const items = list.data?.items ?? [];
  const notice = readListNotice(location.state);
  return (
    <>
      <WorkbenchPage
        storageKey="admin.pipelines"
        centerLabel={t("已保存的元件組合")}
        dockLabel={t("輸出面板")}
        dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> }]}
        center={
          <>
            <DocTabs label={t("開啟的文件")} tabs={[{ ...LIST_TAB, active: true }]} />
            <PageHeader
              icon={<AreaIcon area="components" size={28} />}
              title={t("元件組合")}
              description={t("pipeline：步驟清單＋每個輸入埠的來源構成 DAG；每一步選一個 instance（任何 Node），流程輸出標在產生它的接點上。分類與順序只影響顯示（左欄可拖曳），Image／Video Studio 與推理 Studio 依同一順序列出。")}
              className="shrink-0 border-b border-line-subtle px-4 py-3"
              actions={createActions}
            />
            <div className="relative flex min-h-0 flex-1 flex-col">
              {notice ? (
                <Callout tone="info" title={t("伺服器上已經沒有這個元件組合")} className="m-4 mb-0 shrink-0 animate-rise-in">
                  <p>
                    <T source={"<0>{pipelineId}</0> 可能已在其他視窗或分頁刪除；清單已更新。已建立的 run 仍保有各自的副本。"} values={{ pipelineId: notice.pipelineId }} slots={[<code className="machine" />]} />
                  </p>
                  <Button size="sm" variant="quiet" icon={<X aria-hidden />} onClick={() => void navigate(location.pathname, { replace: true, state: null })}>
                    {t("關閉這則訊息")}
                  </Button>
                </Callout>
              ) : null}
              <LayoutStatus editor={editor} />
              {list.isPending || (editor.layout.isPending && !editor.layout.data) ? (
                <LoadingRows label={t("讀取元件組合清單…")} />
              ) : list.isError ? (
                <div className="p-4">
                  <ErrorCallout error={list.error} title={t("無法讀取元件組合清單")} onRetry={() => void list.refetch()} retrying={list.isFetching} />
                </div>
              ) : items.length === 0 ? (
                // 什麼都還沒有＝品牌時刻（插圖）；頁首已有主要動作「從範本建立」，這裡用次要按鈕，一個畫面只有一個主要動作
                <EmptyState
                  illustration="frames"
                  title={t("尚未保存任何元件組合")}
                  description={t("範本：生成（TE→DiT→正式解碼）、參考生成（TE→參考編碼→DiT→正式解碼）、反推語意→caption。")}
                  action={
                    <Button icon={<LayoutTemplate aria-hidden />} onClick={() => setTemplateOpen(true)}>
                      {t("從範本建立")}
                    </Button>
                  }
                />
              ) : (
                <PipelineTable editor={editor} />
              )}
              <p role="status" className="sr-only">
                {editor.announcement}
              </p>
            </div>
          </>
        }
      />
      {dialog}
    </>
  );
}
