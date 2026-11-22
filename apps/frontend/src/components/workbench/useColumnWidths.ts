// 可調欄寬的狀態與保存（這台瀏覽器的偏好）：拖曳中只更新畫面，放開或鍵盤調整後才寫入 localStorage；
// 讀寫失敗（私密模式、停用儲存）時用預設寬度，只在這次工作階段生效。
import { useEffect, useState } from "react";
import { columnStorageKey, parseStoredWidths, resetColumnWidth, serializeWidths, setColumnWidth, totalColumnWidth, type ColumnSpec, type ColumnWidths } from "./columnWidths";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 只在這次工作階段生效
  }
}

export interface ColumnWidthsApi {
  widths: ColumnWidths;
  /** 所有欄寬的總和（表格最小寬度）。 */
  total: number;
  /** 拖曳中：只更新畫面。 */
  preview: (id: string, width: number) => void;
  /** 確定寬度（放開拖曳、鍵盤調整）：更新並保存。 */
  commit: (id: string, width: number) => void;
  /** 還原預設寬度並保存。 */
  reset: (id: string) => void;
}

/** specs 請傳模組層級的常數（同一個陣列），避免每次重繪都重新保存。 */
export function useColumnWidths(tableId: string, specs: readonly ColumnSpec[]): ColumnWidthsApi {
  const key = columnStorageKey(tableId);
  const [state, setState] = useState<{ widths: ColumnWidths; dragging: boolean }>(() => ({
    widths: parseStoredWidths(readStored(key), specs),
    dragging: false,
  }));

  useEffect(() => {
    if (!state.dragging) writeStored(key, serializeWidths(state.widths, specs));
  }, [state, key, specs]);

  return {
    widths: state.widths,
    total: totalColumnWidth(state.widths, specs),
    preview: (id, width) => { setState((current) => ({ widths: setColumnWidth(current.widths, specs, id, width), dragging: true })); },
    commit: (id, width) => { setState((current) => ({ widths: setColumnWidth(current.widths, specs, id, width), dragging: false })); },
    reset: (id) => { setState((current) => ({ widths: resetColumnWidth(current.widths, specs, id), dragging: false })); },
  };
}
