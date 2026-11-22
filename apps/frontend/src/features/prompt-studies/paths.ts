// 站內路徑：常數來自 app/paths.ts（站內路徑的唯一來源）；頁面本身用目前 pathname 加 search 切換研究，不依賴這裡的常數。
import { PATHS } from "@/app/paths";

/** 推理 Studio・圖片反推。 */
export const PROMPT_STUDIES_PATH = PATHS.promptStudies;
/** Image Studio。 */
export const IMAGE_STUDIO_PATH = PATHS.image;

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null && value !== "") query.set(key, value);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** 圖片反推：?study=&tab=。 */
export function promptStudyPath(params: { study?: string | null; tab?: string | null } = {}, base = PROMPT_STUDIES_PATH): string {
  return withQuery(base, { study: params.study, tab: params.tab });
}

/** Image Studio 的某個專案與圖片鏡頭（?project=&shot=；與 Video Studio 相同的參數慣例）。 */
export function imageStudioShotPath(projectId: string, imageShotId: string): string {
  return withQuery(IMAGE_STUDIO_PATH, { project: projectId, shot: imageShotId });
}
