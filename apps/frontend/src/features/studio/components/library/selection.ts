// 素材庫的多選（純函式）：點一下＝只選它；Ctrl／Cmd＝加入或取消；Shift＝從錨點到它的範圍（Ctrl＋Shift 加到原本的選取）。
// focus＝目前項目（詳細資料顯示它、鍵盤從它移動），anchor＝範圍選取的起點。

export interface LibrarySelection {
  ids: ReadonlySet<string>;
  focus: string | null;
  anchor: string | null;
}

export const NO_SELECTION: LibrarySelection = { ids: new Set(), focus: null, anchor: null };

export function selectOnly(id: string): LibrarySelection {
  return { ids: new Set([id]), focus: id, anchor: id };
}

export function toggleSelected(selection: LibrarySelection, id: string): LibrarySelection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, focus: id, anchor: id };
}

/** order＝畫面上的順序（篩選與排序後）。錨點不在畫面上時從 id 開始。 */
export function selectRange(selection: LibrarySelection, order: readonly string[], id: string, additive: boolean): LibrarySelection {
  const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : id;
  const from = order.indexOf(anchor);
  const to = order.indexOf(id);
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return { ids: new Set([...(additive ? selection.ids : []), ...range]), focus: id, anchor };
}

export function selectAll(order: readonly string[], focus: string | null): LibrarySelection {
  return { ids: new Set(order), focus: focus ?? order[0] ?? null, anchor: focus ?? order[0] ?? null };
}

/** 只留下還在畫面上的項目（篩選改變或素材被移除後）。 */
export function visibleSelection(selection: LibrarySelection, order: readonly string[]): LibrarySelection {
  const present = new Set(order);
  const ids = [...selection.ids].filter((id) => present.has(id));
  const focus = selection.focus !== null && present.has(selection.focus) ? selection.focus : null;
  if (ids.length === selection.ids.size && focus === selection.focus) return selection;
  return { ids: new Set(ids), focus, anchor: selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : focus };
}
