// 頂欄的麵包屑（純函式）：目前工作區＋頁面名稱，只看 pathname（不讀資料、不發請求）。
// 頁面名稱沿用各工作區左欄的節名（紀錄、推理、元件修改）；Video Studio 的工作區名稱與 features/studio/workspaces.ts 相同
// （那個模組會載入整個 Studio，這裡不 import，改列在下面）。
import { AREAS, areaOf, type AreaSpec } from "@/app/areas";
import { INFERENCE_SECTIONS } from "@/app/layout/inference/inferenceTree";
import { RECORDS_SECTIONS } from "@/app/layout/records/recordsTree";
import { t } from "@/i18n";

export interface ShellCrumbs {
  area: AreaSpec | null;
  /** 工作區內的頁面名稱；工作區首頁或未知頁面時 null。 */
  page: string | null;
  /** 第三層（例如某一個 run 的詳情）。 */
  detail: string | null;
}

const STUDIO_WORKSPACE_LABELS: Readonly<Record<string, string>> = { edit: t("編輯"), effects: t("效果"), render: t("渲染") };
const ADMIN_PAGE_LABELS: Readonly<Record<string, string>> = { components: t("元件"), pipelines: t("元件組合") };

function sectionLabel(sections: readonly { id: string; label: string }[], id: string | undefined): string | null {
  return sections.find((section) => section.id === id)?.label ?? null;
}

export function shellCrumbs(pathname: string): ShellCrumbs {
  const areaId = areaOf(pathname);
  const area = AREAS.find((item) => item.id === areaId) ?? null;
  const parts = pathname.split("/").filter(Boolean);
  const [, second, third] = parts;
  let page: string | null = null;
  let detail: string | null = null;
  if (areaId === "studio") page = second ? (STUDIO_WORKSPACE_LABELS[second] ?? null) : null;
  else if (areaId === "inference") page = sectionLabel(INFERENCE_SECTIONS, second);
  else if (areaId === "admin") {
    page = second ? (ADMIN_PAGE_LABELS[second] ?? null) : null;
    if (second === "pipelines" && third) detail = third === "new" ? t("新增") : decodeSafe(third);
  } else if (areaId === "records") {
    page = sectionLabel(RECORDS_SECTIONS, second);
    if (page && third) detail = shortId(decodeSafe(third));
  }
  return { area, page, detail: page ? detail : null };
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** UUID 之類的長 ID 只顯示前 8 碼（完整值在頁面本身）。 */
function shortId(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) ? value.slice(0, 8) : value;
}
