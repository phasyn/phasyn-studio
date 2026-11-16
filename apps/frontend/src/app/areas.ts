// 頂層工作區（側欄導覽）：Image Studio｜Video Studio｜推理 Studio｜元件修改｜紀錄。哪一個是目前工作區只看 pathname 的第一段。
// Image Studio 與 Video Studio 共用同一個專案：在兩者之間切換時帶著 ?project=（StudioMemory，這個分頁的記憶，不存瀏覽器）。
import { BrainCircuit, Clapperboard, History, Images, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { imageStudioPath, PATHS, videoStudioPath } from "./paths";
import { t } from "@/i18n";

export type AreaId = "image" | "studio" | "inference" | "admin" | "records";

export interface AreaSpec {
  id: AreaId;
  /** 點工作區時前往的頁面（Image／Video Studio 另外帶上目前的專案，見 areaLink）。 */
  to: string;
  label: string;
  icon: LucideIcon;
  /** 一行說明（tooltip）。 */
  hint: string;
  /** Phasyn 子品牌（概念板：ASSETS／STORY／FLOW／ENGINE／LAB）；側欄的英文小標，純裝飾，不進無障礙名稱。 */
  brand?: string;
}

export const AREAS: readonly AreaSpec[] = [
  { id: "image", to: PATHS.image, label: "Image Studio", icon: Images, hint: t("生成圖片（文生圖、圖生圖）；結果進專案素材庫，可直接用在影片鏡頭"), brand: "ASSETS" },
  { id: "studio", to: PATHS.studio, label: "Video Studio", icon: Clapperboard, hint: t("鏡頭、渲染與剪輯"), brand: "STORY" },
  { id: "inference", to: PATHS.inference, label: t("推理 Studio"), icon: BrainCircuit, hint: t("反推（語意與資料集）、圖片反推、手動執行元件組合"), brand: "FLOW" },
  { id: "admin", to: PATHS.components, label: t("元件修改"), icon: SlidersHorizontal, hint: t("元件 instance 與元件組合（pipeline）"), brand: "ENGINE" },
  { id: "records", to: PATHS.runs, label: t("紀錄"), icon: History, hint: t("執行紀錄、效能紀錄、比較與追蹤設定"), brand: "LAB" },
];

const AREA_IDS: ReadonlySet<string> = new Set<AreaId>(["image", "studio", "inference", "admin", "records"]);

function isAreaId(value: string): value is AreaId {
  return AREA_IDS.has(value);
}

/** 目前所在的工作區；不屬於任何工作區（例如 404）回傳 null。 */
export function areaOf(pathname: string): AreaId | null {
  const head = pathname.split("/").find((part) => part.length > 0);
  return head !== undefined && isAreaId(head) ? head : null;
}

// ── Image Studio ⇄ Video Studio：同一個專案 ────────────────────────────────

/** Video Studio 的工作區（/studio/:workspace）；其他值不記（StudioPage 會導回編輯）。 */
const VIDEO_WORKSPACES: ReadonlySet<string> = new Set(["generate", "edit", "render"]);

/** 這個分頁最近一次在 Image／Video Studio 開啟的專案，以及最近一次的 Video Studio 工作區。 */
export interface StudioMemory {
  projectId: string | null;
  videoWorkspace: string | null;
}

export const EMPTY_STUDIO_MEMORY: StudioMemory = { projectId: null, videoWorkspace: null };

/**
 * 依目前網址更新記憶（沒有變化時回傳同一個物件）：在 Image／Video Studio 時記下 ?project=——沒有專案（專案列表、
 * 剛刪除專案）就清除，所以不會帶著已不存在的專案；其他工作區不改變記憶。
 */
export function rememberStudio(memory: StudioMemory, pathname: string, search: string): StudioMemory {
  const area = areaOf(pathname);
  if (area !== "image" && area !== "studio") return memory;
  const raw = new URLSearchParams(search).get("project");
  const projectId = raw && raw.trim() ? raw : null;
  const workspace = area === "studio" ? (pathname.split("/").filter(Boolean)[1] ?? null) : null;
  const videoWorkspace = workspace && VIDEO_WORKSPACES.has(workspace) ? workspace : memory.videoWorkspace;
  if (projectId === memory.projectId && videoWorkspace === memory.videoWorkspace) return memory;
  return { projectId, videoWorkspace };
}

/** 側欄的連結：Image／Video Studio 帶著同一個專案（Video Studio 回到上次的工作區）；其他工作區是固定入口。 */
export function areaLink(area: AreaSpec, memory: StudioMemory): string {
  if (area.id === "image") return memory.projectId ? imageStudioPath(memory.projectId) : area.to;
  if (area.id === "studio") return memory.projectId ? videoStudioPath(memory.videoWorkspace ?? "generate", memory.projectId) : area.to;
  return area.to;
}
