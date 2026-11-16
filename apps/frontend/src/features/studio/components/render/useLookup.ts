// Step component → provider lookup of the Studio catalog (memoised per catalog).
import { useMemo } from "react";
import { catalogLookup, type ProviderLookup } from "../../model/progress";
import { useStudio } from "../../studioContext";

/** 步驟元件 → provider（由元件目錄查）；元件已刪除時退回步驟 id。 */
export function useLookup(): ProviderLookup {
  const { catalog } = useStudio();
  return useMemo(() => catalogLookup(catalog), [catalog]);
}
