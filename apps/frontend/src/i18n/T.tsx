import type { ReactElement, ReactNode } from "react";
import { renderRich } from "./rich";

export interface TProps {
  /** 繁中原文（目錄的 key），可含 {name}、<n>…</n>、<n/>。 */
  source: string;
  /** {name} 的值：文字、數字或 React 節點。 */
  values?: Readonly<Record<string, ReactNode>>;
  /** <n> 對應的元素（內容由訊息決定）。 */
  slots?: readonly ReactElement[];
  /** 同形異義原文的 context（見 t() 的 options.context）。 */
  context?: string;
}

/** 含行內元素或 React 節點值的整句（由 i18n codemod 產生；一般文字用 t()）。 */
export function T({ source, values, slots, context }: TProps): ReactNode {
  return renderRich(source, values, slots, context);
}
