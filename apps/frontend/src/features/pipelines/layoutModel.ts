// 元件組合分類與排序（PipelineLayout）的純函式：正規化、分區、移動、分類的新增／改名／刪除、名稱檢查與位置說明。
// 分類只決定顯示順序，不修改任何 Pipeline；「未分類」是固定在最後的虛擬分區（key＝null），不能改名、刪除或移動。
import type { PipelineLayoutGroup } from "@/api/generated/contracts";
import type { PipelineLayoutContent } from "@/api/pipelines";
import { t } from "@/i18n";

export type LayoutContent = PipelineLayoutContent;

/** 分區代號：分類的 group_id；null＝未分類。 */
export type GroupKey = string | null;

export interface PipelineLocation {
  group: GroupKey;
  /** 在分區中的位置（0 起算）。 */
  index: number;
}

export const UNGROUPED_LABEL = t("未分類");
export const GROUP_NAME_MAX = 60;

/** pipeline_id 的排序（與伺服器 Python sorted() 相同：本地 ID 只有 ASCII，依字碼比較）。 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 依目前已保存的元件組合正規化（與伺服器 normalize_layout 相同）：略過不存在與重複的 ID（保留第一次出現的位置），
 * 沒有列到的元件組合依 pipeline_id 排序後接在未分類最後；空的分類保留。
 */
export function normalizeLayout(layout: LayoutContent, pipelineIds: readonly string[]): LayoutContent {
  const known = new Set(pipelineIds);
  const seen = new Set<string>();
  const keep = (ids: readonly string[]) =>
    ids.filter((id) => {
      if (!known.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const groups = layout.groups.map((group) => ({ ...group, pipeline_ids: keep(group.pipeline_ids) }));
  const ungrouped = keep(layout.ungrouped);
  ungrouped.push(...[...known].filter((id) => !seen.has(id)).sort(compareIds));
  return { groups, ungrouped };
}

/** 顯示順序：分類依序（組內依序），然後未分類。 */
export function layoutOrder(layout: LayoutContent): string[] {
  return [...layout.groups.flatMap((group) => group.pipeline_ids), ...layout.ungrouped];
}

/** 分區順序：各分類，最後是未分類。 */
export function groupKeys(layout: LayoutContent): GroupKey[] {
  return [...layout.groups.map((group) => group.group_id), null];
}

export function idsOf(layout: LayoutContent, key: GroupKey): readonly string[] {
  if (key === null) return layout.ungrouped;
  return layout.groups.find((group) => group.group_id === key)?.pipeline_ids ?? [];
}

export function findGroup(layout: LayoutContent, groupId: string): PipelineLayoutGroup | undefined {
  return layout.groups.find((group) => group.group_id === groupId);
}

export function groupLabel(layout: LayoutContent, key: GroupKey): string {
  return key === null ? UNGROUPED_LABEL : (findGroup(layout, key)?.name ?? key);
}

export function locatePipeline(layout: LayoutContent, pipelineId: string): PipelineLocation | null {
  for (const group of layout.groups) {
    const index = group.pipeline_ids.indexOf(pipelineId);
    if (index >= 0) return { group: group.group_id, index };
  }
  const index = layout.ungrouped.indexOf(pipelineId);
  return index >= 0 ? { group: null, index } : null;
}

function withIds(layout: LayoutContent, key: GroupKey, ids: string[]): LayoutContent {
  if (key === null) return { groups: layout.groups, ungrouped: ids };
  return { groups: layout.groups.map((group) => (group.group_id === key ? { ...group, pipeline_ids: ids } : group)), ungrouped: layout.ungrouped };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * 把元件組合移到 target.group 的 target.index（以移除它之後的清單計算；超出範圍＝最後）。
 * 回傳新的內容與實際位置；元件組合不存在、目標分類不存在或位置沒有改變時回傳 null。
 */
export function movePipeline(layout: LayoutContent, pipelineId: string, target: PipelineLocation): { layout: LayoutContent; location: PipelineLocation } | null {
  const from = locatePipeline(layout, pipelineId);
  if (!from) return null;
  if (target.group !== null && !findGroup(layout, target.group)) return null;
  const removed = withIds(layout, from.group, idsOf(layout, from.group).filter((id) => id !== pipelineId));
  const destination = [...idsOf(removed, target.group)];
  const index = Math.max(0, Math.min(target.index, destination.length));
  destination.splice(index, 0, pipelineId);
  if (target.group === from.group && sameIds(destination, idsOf(layout, from.group))) return null;
  return { layout: withIds(removed, target.group, destination), location: { group: target.group, index } };
}

/**
 * Alt+↑／↓ 與「上移／下移」：在分區內移一格；已在分區頭（尾）時移到上一個（下一個）分區的最後（最前），
 * 空的分類也可以進去。已經在最上面（最下面）回傳 null。
 */
export function stepPipeline(layout: LayoutContent, pipelineId: string, direction: -1 | 1): { layout: LayoutContent; location: PipelineLocation } | null {
  const from = locatePipeline(layout, pipelineId);
  if (!from) return null;
  const size = idsOf(layout, from.group).length;
  const nextIndex = from.index + direction;
  if (nextIndex >= 0 && nextIndex < size) return movePipeline(layout, pipelineId, { group: from.group, index: nextIndex });
  const keys = groupKeys(layout);
  const neighbour = keys[keys.indexOf(from.group) + direction];
  if (neighbour === undefined) return null;
  return movePipeline(layout, pipelineId, { group: neighbour, index: direction < 0 ? Number.MAX_SAFE_INTEGER : 0 });
}

/** 移到分類（或未分類）的最後；已經在那裡（且是最後一個）時回傳 null。 */
export function movePipelineToGroup(layout: LayoutContent, pipelineId: string, key: GroupKey): { layout: LayoutContent; location: PipelineLocation } | null {
  return movePipeline(layout, pipelineId, { group: key, index: Number.MAX_SAFE_INTEGER });
}

/** 分類換到 toIndex（以移除它之後的清單計算）；沒有改變時回傳 null。 */
export function moveGroup(layout: LayoutContent, groupId: string, toIndex: number): { layout: LayoutContent; index: number } | null {
  const from = layout.groups.findIndex((group) => group.group_id === groupId);
  if (from < 0) return null;
  const rest = layout.groups.filter((group) => group.group_id !== groupId);
  const index = Math.max(0, Math.min(toIndex, rest.length));
  if (index === from) return null;
  rest.splice(index, 0, layout.groups[from] as PipelineLayoutGroup);
  return { layout: { groups: rest, ungrouped: layout.ungrouped }, index };
}

export function stepGroup(layout: LayoutContent, groupId: string, direction: -1 | 1): { layout: LayoutContent; index: number } | null {
  const from = layout.groups.findIndex((group) => group.group_id === groupId);
  if (from < 0) return null;
  const to = from + direction;
  return to < 0 || to >= layout.groups.length ? null : moveGroup(layout, groupId, to);
}

/** 新分類加在所有分類之後（未分類之前）。 */
export function addGroup(layout: LayoutContent, groupId: string, name: string): LayoutContent {
  return { groups: [...layout.groups, { group_id: groupId, name, pipeline_ids: [] }], ungrouped: layout.ungrouped };
}

export function renameGroup(layout: LayoutContent, groupId: string, name: string): LayoutContent {
  return { groups: layout.groups.map((group) => (group.group_id === groupId ? { ...group, name } : group)), ungrouped: layout.ungrouped };
}

/** 刪除分類：裡面的元件組合依原順序接到未分類最後（元件組合本身不刪除）。 */
export function deleteGroup(layout: LayoutContent, groupId: string): LayoutContent {
  const group = findGroup(layout, groupId);
  if (!group) return layout;
  return { groups: layout.groups.filter((item) => item.group_id !== groupId), ungrouped: [...layout.ungrouped, ...group.pipeline_ids] };
}

/** 換行與控制字元（C0、DEL、C1、行／段落分隔符）。 */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** 分類名稱的長度（以字元計，與契約 maxLength 相同）。 */
export function nameLength(name: string): number {
  return [...name].length;
}

/**
 * 分類名稱檢查（輸入值會先去除前後空白）：必填、最多 60 字、單行、不分大小寫不可與其他分類相同、不可用「未分類」。
 * 回傳繁中錯誤訊息；可以使用時回傳 null。
 */
export function groupNameError(name: string, layout: LayoutContent, exceptGroupId: string | null = null): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("請輸入分類名稱");
  const length = nameLength(trimmed);
  if (length > GROUP_NAME_MAX) return t("分類名稱最多 {groupNameMax} 個字（目前 {length} 個）", { groupNameMax: GROUP_NAME_MAX, length });
  if (hasControlCharacter(trimmed)) return t("分類名稱不能包含換行或控制字元");
  const lower = trimmed.toLowerCase();
  if (lower === UNGROUPED_LABEL.toLowerCase()) return t("「{ungroupedLabel}」是固定的分區，請換一個名稱", { ungroupedLabel: UNGROUPED_LABEL });
  const clash = layout.groups.find((group) => group.group_id !== exceptGroupId && group.name.toLowerCase() === lower);
  return clash ? t("已經有名為「{name}」的分類（不分大小寫）", { name: clash.name }) : null;
}

/** 新分類的 group_id（本地 ID）：group-<時間 base36>，與既有的不重複。 */
export function newGroupId(layout: LayoutContent, now: number = Date.now()): string {
  const taken = new Set(layout.groups.map((group) => group.group_id));
  const base = `group-${Math.max(0, Math.floor(now)).toString(36)}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 位置說明：「「正式」第 2 個」。 */
export function describeLocation(layout: LayoutContent, location: PipelineLocation): string {
  return t("「{groupLabel}」第 {index} 個", { groupLabel: groupLabel(layout, location.group), index: location.index + 1 });
}

export interface LayoutSection<T> {
  key: GroupKey;
  name: string;
  items: T[];
}

/** 依分類與排序分區（各分類依序，最後是未分類）；layout 應已正規化（不在清單上的 ID 會略過）。 */
export function layoutSections<T extends { pipeline_id: string }>(layout: LayoutContent, pipelines: readonly T[]): LayoutSection<T>[] {
  const byId = new Map(pipelines.map((pipeline) => [pipeline.pipeline_id, pipeline]));
  const pick = (ids: readonly string[]) => ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as T] : []));
  return [
    ...layout.groups.map((group) => ({ key: group.group_id, name: group.name, items: pick(group.pipeline_ids) })),
    { key: null, name: UNGROUPED_LABEL, items: pick(layout.ungrouped) },
  ];
}
