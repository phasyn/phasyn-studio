import { useState } from "react";
import { ancestorsOf, branchIds, type TreeItem } from "@/components/workbench/treeModel";
import { usePersistentSet } from "@/lib/usePersistentSize";

/**
 * 樹的展開狀態：資料夾預設展開，使用者收合的資料夾記在這台瀏覽器（storageKey）；
 * 選取改變時展開它的祖先（之後手動收合的祖先記在 closed，下次選取改變時重設）；搜尋時暫時展開符合項目的祖先。
 */
export function useFolderExpansion(storageKey: string, items: readonly TreeItem[], selectedId: string | null, searchExpand: ReadonlySet<string>) {
  const [collapsed, setCollapsed] = usePersistentSet(storageKey, []);
  const [lastSelected, setLastSelected] = useState(selectedId);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId);
    setClosed(new Set());
  }
  const ancestors = (selectedId != null && selectedId !== "") ? ancestorsOf(items, selectedId) : [];
  const expanded = new Set<string>([
    ...branchIds(items).filter((id) => !collapsed.has(id)),
    ...ancestors.filter((id) => !closed.has(id)),
    ...searchExpand,
  ]);
  const onToggle = (id: string, open: boolean) => {
    const next = new Set(collapsed);
    if (open) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    if (!open && ancestors.includes(id)) setClosed(new Set([...closed, id]));
    else if (open && closed.has(id)) setClosed(new Set([...closed].filter((value) => value !== id)));
  };
  return { expanded, onToggle };
}
