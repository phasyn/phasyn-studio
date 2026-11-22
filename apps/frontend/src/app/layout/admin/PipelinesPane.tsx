import { changesPage } from "../shell/viewTransition";
import { pageTransition } from "@/lib/dom";
// 「元件組合」分頁：全部元件組合、各分類（資料夾，可收合，順序可拖曳）、未分類；元件組合可拖曳排序或放進分類。
// 鍵盤：Alt+↑／↓ 移動聚焦的元件組合或分類；右鍵、Shift+F10 或列上的 ⋯ 開啟動作選單（每個移動都有對應選項）。
// 分類只決定顯示順序（主控 /api/pipeline-layout），不修改任何元件組合；保存失敗會還原並說明，不自動重送。
import { ArrowDown, ArrowUp, Check, Folder, FolderInput, FolderPlus, Inbox, LoaderCircle, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type SubmitEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DockBody } from "@/components/workbench/DockPanel";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { TreeView, type TreeDragOptions, type TreeMenuAnchor } from "@/components/workbench/TreeView";
import { filterTree, type TreeItem } from "@/components/workbench/treeModel";
import {
  addGroup,
  deleteGroup,
  describeLocation,
  findGroup,
  groupNameError,
  GROUP_NAME_MAX,
  locatePipeline,
  moveGroup,
  movePipeline,
  movePipelineToGroup,
  nameLength,
  newGroupId,
  renameGroup,
  stepGroup,
  stepPipeline,
  LAYOUT_UNSUPPORTED,
  UNGROUPED_LABEL,
  usePipelineLayoutEditor,
  type LayoutContent,
  type PipelineLocation,
} from "@/features/pipelines";
import { ActionMenu } from "@/components/ui/action-menu";
import type { MenuItem } from "@/components/ui/menuModel";
import { isNotFound } from "@/api/pipelines";
import { explorerSelection, pipelineItems, pipelineTreeId } from "./adminTree";
import {
  canDragPipelineTreeItem,
  groupedPipelineItems,
  parsePipelineTreeId,
  PIPELINE_UNGROUPED_ID,
  pipelineGroupTreeId,
  resolvePipelineTreeDrop,
  sectionTreeId,
  type PipelineTreeDrop,
} from "./pipelineTree";
import { SearchBox } from "./SearchBox";
import { useFolderExpansion } from "./useFolderExpansion";
import { t } from "@/i18n";

const INSTRUCTIONS =
  t("拖曳元件組合可調整順序或放進分類（放到分類列＝接在最後），拖曳分類可調整分類順序；Alt+↑／↓ 移動目前的項目；右鍵、Shift+F10 或 ⋯ 按鈕開啟動作選單。");

interface MenuState {
  itemId: string;
  mode: "actions" | "move-to";
  anchor: TreeMenuAnchor;
  returnFocus: HTMLElement | null;
  focus: "first" | "last";
}

type NameFormState = { mode: "create" } | { mode: "rename"; groupId: string };

type MoveResult = { layout: LayoutContent; location: PipelineLocation } | null;

/** 新增分類／重新命名：精簡的行內表單（Enter 送出、Esc 取消），名稱即時檢查。 */
function GroupNameForm({
  form,
  content,
  onSubmit,
  onCancel,
}: {
  form: NameFormState;
  content: LayoutContent;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const group = form.mode === "rename" ? findGroup(content, form.groupId) : undefined;
  const [value, setValue] = useState(group?.name ?? "");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const messageId = useId();
  const error = groupNameError(value, content, group?.group_id ?? null);
  const showError = error !== null && (submitted || value.trim().length > 0);
  const length = nameLength(value.trim());

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (error != null && error !== "") {
      inputRef.current?.focus();
      return;
    }
    onSubmit(value.trim());
  };

  return (
    <form onSubmit={submit} className="grid shrink-0 gap-1 border-b border-line-subtle bg-sunken/60 px-2 py-2" aria-label={group ? t("重新命名分類「{name}」", { name: group.name }) : t("新增分類")}>
      <label htmlFor={inputId} className="text-caption font-medium text-fg-secondary">
        {group ? t("重新命名「{name}」", { name: group.name }) : t("新分類名稱")}
      </label>
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          id={inputId}
          compact
          value={value}
          onChange={(event) => { setValue(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }}
          aria-invalid={showError || undefined}
          aria-describedby={messageId}
          autoComplete="off"
          placeholder={t("例如：正式、實驗")}
        />
        <ToolButton type="submit" label={group ? t("儲存名稱") : t("建立分類")} icon={<Check aria-hidden />} />
        <ToolButton label={t("取消（Esc）")} icon={<X aria-hidden />} onClick={onCancel} />
      </div>
      <div id={messageId} className="text-caption">
        <p aria-live="polite" className="text-danger">
          {showError ? error : ""}
        </p>
        {showError ? null : <p className="text-fg-tertiary">{t("最多 {groupNameMax} 字（目前 {length}）；不分大小寫不可與其他分類同名。", { groupNameMax: GROUP_NAME_MAX, length })}</p>}
      </div>
    </form>
  );
}

/** 刪除分類的確認框：列出會移到未分類的元件組合；元件組合本身不刪除。 */
function DeleteGroupDialog({
  group,
  names,
  onConfirm,
  onClose,
  onClosed,
}: {
  group: { group_id: string; name: string } | null;
  names: string[];
  onConfirm: () => void;
  onClose: () => void;
  /** 關閉後焦點要去的列（null＝交給 Dialog 還原）。 */
  onClosed: () => string | null;
}) {
  return (
    <Dialog
      open={group !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {group ? (
        <DialogContent
          onCloseAutoFocus={(event) => {
            const target = onClosed();
            if (!(target != null && target !== "")) return;
            event.preventDefault();
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tree-item="${CSS.escape(target)}"]`)?.focus());
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("刪除分類「{name}」？", { name: group.name })}</DialogTitle>
            <DialogDescription>
              {t("只刪除這個分類：{value}元件組合本身不會被刪除，已建立的 run 也不受影響。", { value: names.length > 0 ? t("裡面的 {namesCount} 個元件組合會依原順序移到「{ungroupedLabel}」最後。", { namesCount: names.length, ungroupedLabel: UNGROUPED_LABEL }) : t("這個分類是空的。") })}
            </DialogDescription>
          </DialogHeader>
          {names.length > 0 ? (
            <DialogBody>
              <ul className="grid gap-1 text-data text-fg-secondary">
                {names.map((name, index) => (
                  <li key={`${String(index)}:${name}`} className="truncate">
                    {name}
                  </li>
                ))}
              </ul>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="quiet" onClick={onClose}>
              {t("取消")}
            </Button>
            <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} onClick={onConfirm}>
              {t("刪除分類")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** 「元件組合」分頁：搜尋＋新增分類＋新增元件組合，下面是分類樹。 */
export function PipelinesPane({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const editor = usePipelineLayoutEditor();
  const { pipelines, content } = editor;
  const location = useLocation();
  const navigate = useNavigate();
  const paneId = useId();
  const addGroupRef = useRef<HTMLButtonElement>(null);
  const afterDeleteRef = useRef<string | null>(null);
  const menuId = useId();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nameForm, setNameForm] = useState<NameFormState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; nonce: number } | null>(null);

  // 剛移動過的列短暫標示（約 0.9 秒）
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => { setFlash(null); }, 900);
    return () => { window.clearTimeout(timer); };
  }, [flash]);

  const list = pipelines.data?.items ?? [];
  const items = content ? groupedPipelineItems(content, list) : pipelineItems(list);
  const filtered = filterTree(items, query);
  const selectedId = explorerSelection(location.pathname, new URLSearchParams(location.search));
  const { expanded, onToggle } = useFolderExpansion("admin.explorer.pipelineGroups.collapsed", items, selectedId, filtered.expand);
  const searching = query.trim().length > 0;
  const reorderBlocked = editor.blockedReason ?? (searching ? t("搜尋時不能調整順序：清除搜尋後再拖曳或移動") : null);
  const layoutUnsupported = !editor.layout.data && isNotFound(editor.layout.error);

  const pipelineLabel = (pipelineId: string) => (list.find((item) => item.pipeline_id === pipelineId)?.label ?? "") || pipelineId;
  // 移動後列可能換了位置（DOM 節點被移動會失去焦點）：下一個畫面再聚焦（以 DOM 查詢，不在 render 中讀 ref）
  const focusLater = (treeId: string) =>
    requestAnimationFrame(() => document.getElementById(paneId)?.querySelector<HTMLElement>(`[data-tree-item="${CSS.escape(treeId)}"]`)?.focus());
  const flashRow = (id: string) => { setFlash((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 })); };

  const applyPipelineMove = (pipelineId: string, result: MoveResult, via: "drag" | "keyboard" | "menu"): boolean => {
    if (!result) return false;
    const sectionId = sectionTreeId(result.location.group);
    const section = items.find((item) => item.id === sectionId);
    const collapsedTarget = Boolean(section?.children?.length) && !expanded.has(sectionId);
    editor.commit(result.layout, t("「{pipelineId}」已移到{layout}", { pipelineId: pipelineLabel(pipelineId), layout: describeLocation(result.layout, result.location) }));
    // 鍵盤與選單：展開目標分類，焦點才能跟著元件組合；拖曳放進收合的分類：標示分類列
    if (via !== "drag" && !expanded.has(sectionId)) onToggle(sectionId, true);
    flashRow(via === "drag" && collapsedTarget ? sectionId : pipelineTreeId(pipelineId));
    if (via === "menu") focusLater(pipelineTreeId(pipelineId));
    return true;
  };

  const applyGroupMove = (groupId: string, result: { layout: LayoutContent; index: number } | null, via: "drag" | "keyboard" | "menu"): boolean => {
    if (!result) return false;
    const name = findGroup(result.layout, groupId)?.name ?? groupId;
    editor.commit(result.layout, t("分類「{name}」已移到第 {index} 個", { name, index: result.index + 1 }));
    flashRow(pipelineGroupTreeId(groupId));
    if (via === "menu") focusLater(pipelineGroupTreeId(groupId));
    return true;
  };

  const onMoveKey = (item: TreeItem, direction: -1 | 1): boolean => {
    const node = parsePipelineTreeId(item.id);
    const pipelineId = node?.kind === "pipeline" ? node.pipelineId : null;
    const groupId = node?.kind === "group" ? node.key : null;
    if (pipelineId === null && groupId === null) {
      editor.announce(node?.kind === "all" ? t("「全部元件組合」固定在最上面，不能移動") : t("「{ungroupedLabel}」固定在最後，不能移動", { ungroupedLabel: UNGROUPED_LABEL }));
      return false;
    }
    if ((reorderBlocked ?? "") || !content) {
      editor.announce(reorderBlocked ?? t("分類與排序尚未讀取"));
      return false;
    }
    const edge = direction < 0 ? t("最上面") : t("最下面");
    if (pipelineId !== null) {
      const result = stepPipeline(content, pipelineId, direction);
      if (!result) editor.announce(t("「{pipelineId}」已經在{edge}", { pipelineId: pipelineLabel(pipelineId), edge }));
      return applyPipelineMove(pipelineId, result, "keyboard");
    }
    if (groupId === null) return false;
    const result = stepGroup(content, groupId, direction);
    if (!result) editor.announce(t("分類「{value}」已經在{edge}{value2}", { value: findGroup(content, groupId)?.name ?? groupId, edge, value2: direction > 0 ? t("（「{ungroupedLabel}」固定在最後）", { ungroupedLabel: UNGROUPED_LABEL }) : "" }));
    return applyGroupMove(groupId, result, "keyboard");
  };

  const drag: TreeDragOptions<PipelineTreeDrop> | undefined =
    content && !(reorderBlocked != null && reorderBlocked !== "")
      ? {
          canDrag: (item) => canDragPipelineTreeItem(item.id),
          resolve: (sourceId, over, fraction, rows) => resolvePipelineTreeDrop(content, sourceId, over, fraction, rows),
          onDrop: (_sourceId, drop) => {
            if (drop.kind === "pipeline") applyPipelineMove(drop.pipelineId, movePipeline(content, drop.pipelineId, drop.to), "drag");
            else applyGroupMove(drop.groupId, moveGroup(content, drop.groupId, drop.toIndex), "drag");
          },
          onCancel: () => { editor.announce(t("已取消拖曳，順序沒有改變")); },
        }
      : undefined;

  const openNameForm = (form: NameFormState) => {
    setMenu(null);
    setNameForm(form);
  };
  const closeNameForm = () => {
    const form = nameForm;
    setNameForm(null);
    if (form?.mode === "rename") focusLater(pipelineGroupTreeId(form.groupId));
    else requestAnimationFrame(() => addGroupRef.current?.focus());
  };
  const submitName = (name: string) => {
    const form = nameForm;
    if (!content || !form) return;
    setNameForm(null);
    if (form.mode === "create") {
      const groupId = newGroupId(content);
      editor.commit(addGroup(content, groupId, name), t("已新增分類「{name}」（在「{ungroupedLabel}」之前）", { name, ungroupedLabel: UNGROUPED_LABEL }));
      flashRow(pipelineGroupTreeId(groupId));
      focusLater(pipelineGroupTreeId(groupId));
      return;
    }
    const group = findGroup(content, form.groupId);
    focusLater(pipelineGroupTreeId(form.groupId));
    if (!group || group.name === name) return;
    editor.commit(renameGroup(content, form.groupId, name), t("已把分類「{name}」重新命名為「{name2}」", { name: group.name, name2: name }));
  };

  const deleting = content && (deletingId != null && deletingId !== "") ? (findGroup(content, deletingId) ?? null) : null;
  const confirmDelete = () => {
    if (!content || !deleting) return;
    const index = content.groups.findIndex((group) => group.group_id === deleting.group_id);
    const next = content.groups[index + 1] ?? content.groups[index - 1];
    afterDeleteRef.current = next ? pipelineGroupTreeId(next.group_id) : PIPELINE_UNGROUPED_ID;
    const count = deleting.pipeline_ids.length;
    editor.commit(
      deleteGroup(content, deleting.group_id),
      t("已刪除分類「{name}」{value}", { name: deleting.name, value: count > 0 ? t("；{count} 個元件組合移到「{ungroupedLabel}」", { count, ungroupedLabel: UNGROUPED_LABEL }) : "" }),
    );
    setDeletingId(null);
  };

  const pipelineMenu = (pipelineId: string, state: MenuState): MenuItem[] => {
    if (!content) return [];
    const up = stepPipeline(content, pipelineId, -1);
    const down = stepPipeline(content, pipelineId, 1);
    return [
      { id: "up", label: t("上移"), icon: ArrowUp, shortcut: "Alt+↑", disabledReason: reorderBlocked ?? (up ? null : t("已經在最上面")), onSelect: () => void applyPipelineMove(pipelineId, up, "menu") },
      { id: "down", label: t("下移"), icon: ArrowDown, shortcut: "Alt+↓", disabledReason: reorderBlocked ?? (down ? null : t("已經在最下面")), onSelect: () => void applyPipelineMove(pipelineId, down, "menu") },
      {
        id: "move-to",
        label: t("移到分類…"),
        icon: FolderInput,
        separatorBefore: true,
        disabledReason: editor.blockedReason ?? (content.groups.length === 0 ? t("還沒有分類：先按上方的「新增分類」") : null),
        onSelect: () => { setMenu({ ...state, mode: "move-to", anchor: { ...state.anchor } }); },
      },
    ];
  };

  const moveToMenu = (pipelineId: string): MenuItem[] => {
    if (!content) return [];
    const where = locatePipeline(content, pipelineId)?.group;
    return [
      ...content.groups.map<MenuItem>((group) => ({
        id: `group:${group.group_id}`,
        label: group.name,
        icon: Folder,
        disabledReason: where === group.group_id ? t("目前就在這個分類") : null,
        onSelect: () => void applyPipelineMove(pipelineId, movePipelineToGroup(content, pipelineId, group.group_id), "menu"),
      })),
      {
        id: "ungrouped",
        label: UNGROUPED_LABEL,
        icon: Inbox,
        separatorBefore: content.groups.length > 0,
        disabledReason: where === null ? t("目前就在「{ungroupedLabel}」", { ungroupedLabel: UNGROUPED_LABEL }) : null,
        onSelect: () => void applyPipelineMove(pipelineId, movePipelineToGroup(content, pipelineId, null), "menu"),
      },
    ];
  };

  const groupMenu = (groupId: string): MenuItem[] => {
    if (!content) return [];
    const up = stepGroup(content, groupId, -1);
    const down = stepGroup(content, groupId, 1);
    return [
      { id: "rename", label: t("重新命名…"), icon: Pencil, disabledReason: editor.blockedReason, onSelect: () => { openNameForm({ mode: "rename", groupId }); } },
      { id: "up", label: t("上移"), icon: ArrowUp, shortcut: "Alt+↑", separatorBefore: true, disabledReason: reorderBlocked ?? (up ? null : t("已經是第一個分類")), onSelect: () => void applyGroupMove(groupId, up, "menu") },
      {
        id: "down",
        label: t("下移"),
        icon: ArrowDown,
        shortcut: "Alt+↓",
        disabledReason: reorderBlocked ?? (down ? null : t("已經是最後一個分類（「{ungroupedLabel}」固定在最後）", { ungroupedLabel: UNGROUPED_LABEL })),
        onSelect: () => void applyGroupMove(groupId, down, "menu"),
      },
      { id: "delete", label: t("刪除分類…"), icon: Trash2, tone: "danger", separatorBefore: true, disabledReason: editor.blockedReason, onSelect: () => { setDeletingId(groupId); } },
    ];
  };

  const menuNode = menu ? parsePipelineTreeId(menu.itemId) : null;
  const menuItems: MenuItem[] =
    !menu || !menuNode
      ? []
      : menuNode.kind === "pipeline"
        ? menu.mode === "move-to"
          ? moveToMenu(menuNode.pipelineId)
          : pipelineMenu(menuNode.pipelineId, menu)
        : menuNode.kind === "group" && menuNode.key !== null
          ? groupMenu(menuNode.key)
          : [];
  const menuLabel = (item: TreeItem) => {
    const node = parsePipelineTreeId(item.id);
    return node?.kind === "group" ? t("分類「{label}」的動作", { label: item.label }) : t("「{label}」的動作", { label: item.label });
  };
  const menuTitle = (): string => {
    if (!menuNode) return t("動作");
    if (menuNode.kind === "pipeline") {
      const name = pipelineLabel(menuNode.pipelineId);
      return menu?.mode === "move-to" ? t("把「{name}」移到…", { name }) : t("「{name}」的動作", { name });
    }
    const groupName = menuNode.kind === "group" && menuNode.key !== null && content ? findGroup(content, menuNode.key)?.name : undefined;
    return t("分類「{value}」的動作", { value: groupName ?? "" });
  };

  return (
    <div id={paneId} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle p-2">
        <SearchBox value={query} onChange={onQuery} placeholder={t("搜尋元件組合或分類…")} label={t("搜尋元件組合（名稱、pipeline_id）或分類名稱")} />
        <ToolButton
          ref={addGroupRef}
          label={t("新增分類")}
          icon={<FolderPlus aria-hidden />}
          pressed={nameForm?.mode === "create"}
          disabledReason={editor.blockedReason}
          onClick={() => { if (nameForm?.mode === "create") { closeNameForm(); } else { openNameForm({ mode: "create" }); } }}
        />
        <ToolButton label={t("新增元件組合")} icon={<Plus aria-hidden />} onClick={() => void navigate("/admin/pipelines/new")} />
      </div>
      {nameForm && content && (nameForm.mode === "create" || findGroup(content, nameForm.groupId)) ? (
        <GroupNameForm key={nameForm.mode === "rename" ? `rename:${nameForm.groupId}` : "create"} form={nameForm} content={content} onSubmit={submitName} onCancel={closeNameForm} />
      ) : null}
      {editor.saving ? (
        <p className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-3 py-1 text-caption text-fg-tertiary">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          {t("正在保存分類與排序…")}
        </p>
      ) : null}
      {(editor.error != null && editor.error !== "") ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-line-subtle bg-sunken px-3 py-2 text-caption text-fg-secondary">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{editor.error}</span>
          <ToolButton label={t("關閉這則訊息")} icon={<X aria-hidden />} onClick={editor.dismissError} className="-my-1" />
        </div>
      ) : null}
      {layoutUnsupported ? (
        <p className="shrink-0 border-b border-line-subtle px-3 py-2 text-caption text-fg-tertiary">{t("{layoutUnsupported}；目前依 ID 排序，不能分類或拖曳。", { layoutUnsupported: LAYOUT_UNSUPPORTED })}</p>
      ) : null}
      <DockBody>
        {pipelines.isPending || editor.layout.isPending ? (
          <p role="status" className="px-3 py-4 text-caption text-fg-secondary">
            {t("正在讀取元件組合…")}
          </p>
        ) : pipelines.isError && !pipelines.data ? (
          <div className="p-2">
            <ErrorCallout error={pipelines.error} title={t("無法讀取元件組合")} onRetry={() => void pipelines.refetch()} retrying={pipelines.isFetching} />
          </div>
        ) : (
          <>
            {editor.layout.isError && !editor.layout.data && !layoutUnsupported ? (
              <div className="p-2">
                <ErrorCallout error={editor.layout.error} title={t("無法讀取分類與排序（依 ID 排序顯示）")} onRetry={() => void editor.layout.refetch()} retrying={editor.layout.isFetching} />
              </div>
            ) : null}
            {filtered.items.length === 0 ? (
              <p className="px-3 py-4 text-caption text-fg-tertiary">{t("找不到符合「{query}」的元件組合或分類。", { query: query.trim() })}</p>
            ) : (
              <TreeView<PipelineTreeDrop>
                items={filtered.items}
                label={t("元件組合")}
                selectedId={selectedId}
                expanded={expanded}
                onToggle={onToggle}
                onActivate={(item) => {
                  if (item.to != null && item.to !== "") void navigate(item.to, pageTransition(changesPage(item.to, location.pathname)));
                }}
                {...(drag === undefined ? {} : { drag })}
                onMoveKey={onMoveKey}
                {...(content ? { menu: {
                        menuId,
                        openId: menu?.itemId ?? null,
                        has: (item) => canDragPipelineTreeItem(item.id),
                        label: menuLabel,
                        open: (item, anchor, returnFocus, focus) => { setMenu({ itemId: item.id, mode: "actions", anchor, returnFocus, focus }); },
                        close: () => { setMenu(null); },
                      } } : {})}
                highlightId={flash?.id ?? null}
                {...(content ? { instructions: INSTRUCTIONS } : {})}
              />
            )}
            {pipelines.data.items.length === 0 && !searching ? (
              <p className="px-3 pb-3 text-caption text-fg-tertiary">{t("尚未保存任何元件組合：按「＋」新增，或在清單頁從範本建立。")}</p>
            ) : null}
          </>
        )}
        <p role="status" className="sr-only">
          {editor.announcement}
        </p>
      </DockBody>
      {menu && menuItems.length > 0 ? (
        <ActionMenu
          key={`${menu.itemId}:${menu.mode}`}
          id={menuId}
          label={menuTitle()}
          items={menuItems}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          initialFocus={menu.focus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
      <DeleteGroupDialog
        group={deleting}
        names={deleting ? deleting.pipeline_ids.map(pipelineLabel) : []}
        onConfirm={confirmDelete}
        onClose={() => { setDeletingId(null); }}
        onClosed={() => {
          const target = afterDeleteRef.current;
          afterDeleteRef.current = null;
          return target;
        }}
      />
    </div>
  );
}
