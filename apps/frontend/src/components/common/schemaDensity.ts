import { createContext } from "react";

/** SchemaForm 的版面密度：comfortable＝標籤在上（一般頁面）；compact＝Inspector 的 label｜值屬性格（32 px 控制）。 */
export type SchemaDensity = "comfortable" | "compact";

export const SchemaDensityContext = createContext<SchemaDensity>("comfortable");
