// 可編輯清單的穩定 React key：清單項目沒有不可變的 domain ID（或 ID 本身可被編輯）時使用。
// 新增／刪除／移動經由這裡的操作同步 key；外部改變長度時（例如 JSON 編輯）以確定性 key 補齊，不在 render 中 setState。
import { useState } from "react";

export interface StableKeys {
  keys: string[];
  append: () => void;
  remove: (index: number) => void;
  move: (from: number, to: number) => void;
}

export function useStableKeys(count: number): StableKeys {
  const [state, setState] = useState<{ keys: string[]; next: number }>({ keys: [], next: 0 });
  const keys = Array.from({ length: count }, (_, index) => state.keys[index] ?? `k${String(count)}-${String(index)}`);
  return {
    keys,
    append: () => { setState({ keys: [...keys, `n${String(state.next)}`], next: state.next + 1 }); },
    remove: (index) => { setState({ keys: keys.filter((_, position) => position !== index), next: state.next }); },
    move: (from, to) => {
      if (to < 0 || to >= keys.length) return;
      const copy = [...keys];
      const [item] = copy.splice(from, 1);
      if (item !== undefined) copy.splice(to, 0, item);
      setState({ keys: copy, next: state.next });
    },
  };
}

/** 陣列不可變操作（與 useStableKeys 配對使用）。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return [...items];
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  if (item !== undefined) copy.splice(to, 0, item);
  return copy;
}
