// 紀錄表的畫面狀態：篩選、「清除畫面」（只是 since 分界，不刪伺服器資料）、換行模式。
import { useMemo, useState } from "react";
import {
  clearCutoff,
  countCleared,
  DEFAULT_LOG_FILTER,
  filterLines,
  hasActiveFilters,
  sourceKindsIn,
  type LogFilter,
  type LogLine,
  type LogSourceKind,
} from "./model";

export interface LogView {
  filter: LogFilter;
  setFilter: (next: LogFilter) => void;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
  /** 篩選後（由舊到新）。 */
  visible: LogLine[];
  total: number;
  /** 被「清除畫面」隱藏的筆數。 */
  cleared: number;
  /** 資料中出現的來源類型（含目前選取的類型）。 */
  sourceKinds: LogSourceKind[];
  filtersActive: boolean;
  /** 隱藏目前所有紀錄（之後的新紀錄照常出現）。 */
  clear: () => void;
  /** 取消「清除畫面」。 */
  restore: () => void;
  /** 清除等級／來源／文字篩選（保留「清除畫面」分界）。 */
  resetFilters: () => void;
}

export function useLogView(lines: readonly LogLine[]): LogView {
  const [filter, setFilter] = useState<LogFilter>(DEFAULT_LOG_FILTER);
  const [wrap, setWrap] = useState(false);
  const visible = useMemo(() => filterLines(lines, filter), [lines, filter]);
  const cleared = useMemo(() => countCleared(lines, filter.since), [lines, filter.since]);
  const sourceKinds = useMemo(() => {
    const kinds = sourceKindsIn(lines);
    return filter.source !== "all" && !kinds.includes(filter.source) ? [...kinds, filter.source] : kinds;
  }, [lines, filter.source]);
  return {
    filter,
    setFilter,
    wrap,
    setWrap,
    visible,
    total: lines.length,
    cleared,
    sourceKinds,
    filtersActive: hasActiveFilters(filter),
    clear: () => {
      const cutoff = clearCutoff(lines);
      if (cutoff != null && cutoff !== "") setFilter((current) => ({ ...current, since: cutoff }));
    },
    restore: () => { setFilter((current) => ({ ...current, since: null })); },
    resetFilters: () => { setFilter((current) => ({ ...DEFAULT_LOG_FILTER, since: current.since })); },
  };
}
