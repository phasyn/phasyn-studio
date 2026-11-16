// 可調欄寬的表格（純函式）：每欄有預設與最小寬度；使用者的寬度依表格存在這台瀏覽器（localStorage）。
// 儲存值一律重新檢查（未知欄位忽略、非數字用預設、超出範圍夾回），讀寫失敗不影響表格。

export interface ColumnSpec {
  id: string;
  /** 欄位名稱（調整把手的無障礙名稱用）。 */
  label: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth?: number;
}

export type ColumnWidths = Readonly<Record<string, number>>;

/** 沒有指定上限時的最大寬度。 */
export const COLUMN_MAX_WIDTH = 960;
/** 鍵盤每次調整的寬度（Shift＝大步）。 */
export const COLUMN_KEY_STEP = 16;
export const COLUMN_KEY_STEP_LARGE = 64;

export function columnStorageKey(tableId: string): string {
  return `phasyn.columns.${tableId}`;
}

export function maxWidthOf(spec: ColumnSpec): number {
  return Math.max(spec.minWidth, spec.maxWidth ?? COLUMN_MAX_WIDTH);
}

/** 整數像素並夾在 [minWidth, maxWidth]；非有限數字回傳預設寬度。 */
export function clampColumnWidth(spec: ColumnSpec, width: number): number {
  if (!Number.isFinite(width)) return clampColumnWidth(spec, spec.defaultWidth);
  return Math.min(maxWidthOf(spec), Math.max(spec.minWidth, Math.round(width)));
}

export function defaultColumnWidths(specs: readonly ColumnSpec[]): Record<string, number> {
  return Object.fromEntries(specs.map((spec) => [spec.id, clampColumnWidth(spec, spec.defaultWidth)]));
}

/** 解析儲存值（JSON 物件）；任何錯誤都退回預設。 */
export function parseStoredWidths(raw: string | null, specs: readonly ColumnSpec[]): Record<string, number> {
  const widths = defaultColumnWidths(specs);
  if (raw === null) return widths;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return widths;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return widths;
  const record = parsed as Record<string, unknown>;
  for (const spec of specs) {
    const value = record[spec.id];
    if (typeof value === "number" && Number.isFinite(value)) widths[spec.id] = clampColumnWidth(spec, value);
  }
  return widths;
}

/** 只存與預設不同的欄位（預設改了之後，沒調整過的欄會跟著新預設）。 */
export function serializeWidths(widths: ColumnWidths, specs: readonly ColumnSpec[]): string {
  const out: Record<string, number> = {};
  for (const spec of specs) {
    const value = widths[spec.id];
    if (value !== undefined && value !== clampColumnWidth(spec, spec.defaultWidth)) out[spec.id] = value;
  }
  return JSON.stringify(out);
}

export function widthOf(widths: ColumnWidths, spec: ColumnSpec): number {
  return widths[spec.id] ?? clampColumnWidth(spec, spec.defaultWidth);
}

/** 設定一欄的寬度（夾在範圍內）；沒有變化時回傳同一個物件。 */
export function setColumnWidth(widths: ColumnWidths, specs: readonly ColumnSpec[], id: string, width: number): ColumnWidths {
  const spec = specs.find((item) => item.id === id);
  if (!spec) return widths;
  const next = clampColumnWidth(spec, width);
  if (widths[id] === next) return widths;
  return { ...widths, [id]: next };
}

export function resetColumnWidth(widths: ColumnWidths, specs: readonly ColumnSpec[], id: string): ColumnWidths {
  const spec = specs.find((item) => item.id === id);
  return spec ? setColumnWidth(widths, specs, id, spec.defaultWidth) : widths;
}

export function totalColumnWidth(widths: ColumnWidths, specs: readonly ColumnSpec[]): number {
  return specs.reduce((sum, spec) => sum + widthOf(widths, spec), 0);
}

/** 拖曳：起始寬度＋指標水平位移（夾在範圍內）。 */
export function dragColumnWidth(spec: ColumnSpec, startWidth: number, startX: number, currentX: number): number {
  return clampColumnWidth(spec, startWidth + (currentX - startX));
}

/** 欄寬把手的鍵盤：←／→ 調整（Shift 大步）、Home 還原預設；其他鍵＝null（不處理）。 */
export function columnKeyAction(key: string, shiftKey: boolean): { delta: number } | { reset: true } | null {
  const step = shiftKey ? COLUMN_KEY_STEP_LARGE : COLUMN_KEY_STEP;
  if (key === "ArrowLeft") return { delta: -step };
  if (key === "ArrowRight") return { delta: step };
  if (key === "Home") return { reset: true };
  return null;
}
