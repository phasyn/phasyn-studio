// 每個資料來源的讀取狀態（讀取中／失敗／過時），讓紀錄表能顯示「部分資料」而不是整塊失敗。

export interface SourceStatus {
  /** 來源名稱（繁中，顯示在錯誤列）。 */
  label: string;
  /** 尚無資料且正在讀取。 */
  loading: boolean;
  fetching: boolean;
  /** 最近一次讀取的錯誤；null＝沒有錯誤。有舊資料時代表畫面是過時資料。 */
  error: unknown;
  hasData: boolean;
}

interface QueryLike {
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  data: unknown;
}

export function sourceStatus(label: string, query: QueryLike): SourceStatus {
  return {
    label,
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error ?? null,
    hasData: query.data !== undefined,
  };
}
