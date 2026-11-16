// 「元件組合」分頁的樹（純函式）：全部元件組合、各分類（資料夾，依使用者的順序）、最後是未分類；
// 以及拖曳時的放置位置計算（插入線／放進分類）。分類只決定顯示順序，不修改任何元件組合。
import { Folder, Inbox } from "lucide-react";
import type { WirePipeline } from "@/api/types";
import type { TreeDropResult, TreeItem, TreeRow } from "@/components/workbench/treeModel";
import {
  idsOf,
  layoutSections,
  locatePipeline,
  moveGroup,
  movePipeline,
  movePipelineToGroup,
  UNGROUPED_LABEL,
  type GroupKey,
  type LayoutContent,
  type PipelineLocation,
} from "@/features/pipelines";
import { PIPELINE_LIST_ID, pipelineItem, pipelineListItem } from "./adminTree";
import { t } from "@/i18n";

export const PIPELINE_UNGROUPED_ID = "pipelines:ungrouped";
const GROUP_PREFIX = "pipeline-group:";
const PIPELINE_PREFIX = "pipeline:";

export const pipelineGroupTreeId = (groupId: string) => `${GROUP_PREFIX}${groupId}`;

/** 分區（分類或未分類）在樹上的列 ID。 */
export function sectionTreeId(key: GroupKey): string {
  return key === null ? PIPELINE_UNGROUPED_ID : pipelineGroupTreeId(key);
}

export type PipelineTreeNode = { kind: "all" } | { kind: "group"; key: GroupKey } | { kind: "pipeline"; pipelineId: string };

export function parsePipelineTreeId(id: string): PipelineTreeNode | null {
  if (id === PIPELINE_LIST_ID) return { kind: "all" };
  if (id === PIPELINE_UNGROUPED_ID) return { kind: "group", key: null };
  if (id.startsWith(GROUP_PREFIX)) return { kind: "group", key: id.slice(GROUP_PREFIX.length) };
  if (id.startsWith(PIPELINE_PREFIX)) return { kind: "pipeline", pipelineId: id.slice(PIPELINE_PREFIX.length) };
  return null;
}

/** 全部元件組合＋各分類（含空的）＋未分類；layout 應已依清單正規化。 */
export function groupedPipelineItems(layout: LayoutContent, pipelines: readonly WirePipeline[]): TreeItem[] {
  return [
    pipelineListItem(pipelines.length),
    ...layoutSections(layout, pipelines).map((section) => {
      const count = section.items.length;
      return {
        id: sectionTreeId(section.key),
        label: section.name,
        icon: section.key === null ? Inbox : Folder,
        count,
        title:
          section.key === null
            ? t("{ungroupedLabel}（{count} 個元件組合）：拖曳到分類，或用「移到分類…」整理", { ungroupedLabel: UNGROUPED_LABEL, count })
            : t("分類「{name}」（{count} 個元件組合）：拖曳可調整順序，把元件組合拖到這一列＝放進這個分類", { name: section.name, count }),
        children: section.items.map(pipelineItem),
      } satisfies TreeItem;
    }),
  ];
}

export type PipelineTreeDrop = { kind: "pipeline"; pipelineId: string; to: PipelineLocation } | { kind: "group"; groupId: string; toIndex: number };

/** 可以拖曳：元件組合與分類（全部元件組合、未分類固定不動）。 */
export function canDragPipelineTreeItem(id: string): boolean {
  const node = parsePipelineTreeId(id);
  return node?.kind === "pipeline" || (node?.kind === "group" && node.key !== null);
}

function dropPipeline(layout: LayoutContent, pipelineId: string, over: TreeRow, target: PipelineTreeNode, fraction: number): TreeDropResult<PipelineTreeDrop> | null {
  if (target.kind === "group") {
    // 放到分類列＝接在那個分類最後
    const moved = movePipelineToGroup(layout, pipelineId, target.key);
    return moved ? { indicator: { rowId: over.item.id, position: "inside" }, drop: { kind: "pipeline", pipelineId, to: moved.location } } : null;
  }
  if (target.kind !== "pipeline" || target.pipelineId === pipelineId) return null;
  const at = locatePipeline(layout, target.pipelineId);
  if (!at) return null;
  const before = fraction < 0.5;
  const rest = idsOf(layout, at.group).filter((id) => id !== pipelineId);
  const moved = movePipeline(layout, pipelineId, { group: at.group, index: rest.indexOf(target.pipelineId) + (before ? 0 : 1) });
  if (!moved) return null;
  return { indicator: { rowId: over.item.id, position: before ? "before" : "after", level: over.level }, drop: { kind: "pipeline", pipelineId, to: moved.location } };
}

/** 分類列與它（展開時）的子項構成一個區塊；回傳區塊的列。 */
function blockRows(rows: readonly TreeRow[], groupRowId: string): TreeRow[] {
  const start = rows.findIndex((row) => row.item.id === groupRowId);
  if (start < 0) return [];
  let end = start + 1;
  while (end < rows.length && rows[end]?.parentId === groupRowId) end += 1;
  return rows.slice(start, end);
}

function dropGroup(layout: LayoutContent, groupId: string, over: TreeRow, target: PipelineTreeNode, fraction: number, rows: readonly TreeRow[]): TreeDropResult<PipelineTreeDrop> | null {
  const rest = layout.groups.map((group) => group.group_id).filter((id) => id !== groupId);
  if (target.kind === "all") {
    // 拖到最上面：放在第一個分類之前
    const first = rest[0];
    const moved = first === undefined ? null : moveGroup(layout, groupId, 0);
    return first !== undefined && moved
      ? { indicator: { rowId: pipelineGroupTreeId(first), position: "before", level: 1 }, drop: { kind: "group", groupId, toIndex: moved.index } }
      : null;
  }
  const overGroup: GroupKey | undefined = target.kind === "group" ? target.key : locatePipeline(layout, target.pipelineId)?.group;
  if (overGroup === undefined || overGroup === groupId) return null;
  let toIndex: number;
  let indicator: TreeDropResult<PipelineTreeDrop>["indicator"];
  if (overGroup === null) {
    // 未分類固定在最後：放在所有分類之後
    toIndex = rest.length;
    indicator = { rowId: PIPELINE_UNGROUPED_ID, position: "before", level: 1 };
  } else {
    const block = blockRows(rows, pipelineGroupTreeId(overGroup));
    const position = block.findIndex((row) => row.item.id === over.item.id);
    // 展開且有子項的分類列＝放在它之前（插入線不會跳到子項下方）；收合或空的分類列看列內上下半；
    // 子項看落在區塊的上半或下半
    const before = position <= 0 ? block.length > 1 || fraction < 0.5 : position < block.length / 2;
    toIndex = rest.indexOf(overGroup) + (before ? 0 : 1);
    const last = block[block.length - 1];
    indicator = before || !last ? { rowId: pipelineGroupTreeId(overGroup), position: "before", level: 1 } : { rowId: last.item.id, position: "after", level: 1 };
  }
  const moved = moveGroup(layout, groupId, toIndex);
  return moved ? { indicator, drop: { kind: "group", groupId, toIndex: moved.index } } : null;
}

/**
 * 拖曳 sourceId 到 over 列（fraction＝指標在列內的相對高度）時的放置結果；不能放或位置不變回傳 null。
 * - 元件組合：元件組合列的上半／下半＝插在它之前／之後（可跨分類）；分類或未分類列＝接在那個分區最後。
 * - 分類：以分類區塊（分類列＋展開的子項）的上半／下半決定放在它之前或之後（展開的分類列＝之前）；
 *   全部元件組合列＝最前面，未分類（含它的子項）＝所有分類之後。
 */
export function resolvePipelineTreeDrop(layout: LayoutContent, sourceId: string, over: TreeRow, fraction: number, rows: readonly TreeRow[]): TreeDropResult<PipelineTreeDrop> | null {
  const source = parsePipelineTreeId(sourceId);
  const target = parsePipelineTreeId(over.item.id);
  if (!source || !target) return null;
  if (source.kind === "pipeline") return dropPipeline(layout, source.pipelineId, over, target, fraction);
  if (source.kind === "group" && source.key !== null) return dropGroup(layout, source.key, over, target, fraction, rows);
  return null;
}
