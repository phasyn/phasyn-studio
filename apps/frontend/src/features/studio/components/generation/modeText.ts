// The words and icons of a 方式 (model/generationMode.ts) and of a route as people see it: the route's name (the part
// before 「：」 of its label) with derived badges — task, the DiT's machine, ready — while the full label and the wiring
// stay in tooltips and the engine sheet's detail.
import { ImagePlay, Images, Link2, Type, type LucideIcon } from "lucide-react";
import type { Catalog, StudioProject, StudioShot } from "@/api/generated/contracts";
import { indexCatalog } from "@/api/catalog";
import { firstFrameCandidates, firstFrameImageProblem, predecessor } from "../../model/continuity";
import type { GenerationMode, ModeReading } from "../../model/generationMode";
import { nodeShortName, routeName, type StudioRoute } from "../../model/routes";
import { t } from "@/i18n";

export const MODE_LABEL: Readonly<Record<GenerationMode, string>> = {
  references: t("參考素材"),
  continue: t("接續上一鏡"),
  image: t("首幀圖片"),
  text: t("只用文字"),
};

export const MODE_ICON: Readonly<Record<GenerationMode, LucideIcon>> = { references: Images, continue: Link2, image: ImagePlay, text: Type };

/** One plain line of what a 方式 uses. */
export function modeHint(mode: GenerationMode, project: StudioProject, shot: StudioShot): string {
  if (mode === "references") return t("用 @ 參考的圖片、影片與聲音");
  if (mode === "image") return t("從素材庫選一張圖片當第一格");
  if (mode === "text") return t("只用 prompt，不送出參考素材或首幀");
  const previous = predecessor(project, shot.shot_id).previous?.shot;
  return previous ? t("用「{title}」的最後一格當首幀", { title: previous.title || t("未命名鏡頭") }) : t("用前一個鏡頭的最後一格當首幀");
}

/** Why no library image can be this project's first frame now (none, or none of the frame's aspect ratio); null when one can. */
export function firstFrameImagesProblem(project: StudioProject): string | null {
  const candidates = firstFrameCandidates(project.library ?? []);
  if (candidates.length === 0) return t("專案素材庫沒有可用的圖片：先在專案面板「素材」上傳，或在 Image Studio 生成並加入素材庫");
  if (candidates.every((item) => firstFrameImageProblem(item, project.format) !== null)) {
    return t("素材庫沒有和專案畫面（{width}×{height}）同比例的圖片：H3 會把首幀拉伸變形", { width: project.format.width, height: project.format.height });
  }
  return null;
}

/** What the 方式 field shows, and why it cannot render as it is (a tooltip); problem is null when it can. */
export function readingText(reading: ModeReading): { value: string; problem: string | null } {
  if (reading.mode) {
    const problem =
      reading.issue === "route-missing"
        ? t("這個鏡頭的路線已不存在：在「方式」重新選一次，或在渲染引擎選一條路線")
        : reading.issue === "route-mismatch"
          ? t("路線不能用首幀：在「方式」重新選一次，會換成能用首幀的路線")
          : null;
    return { value: MODE_LABEL[reading.mode], problem };
  }
  if (reading.issue === "loading") return { value: t("讀取中…"), problem: null };
  if (reading.issue === "needs-first-frame") return { value: t("需要首幀"), problem: t("這條路線需要首幀：選「接續上一鏡」或「首幀圖片」") };
  return { value: t("未設定"), problem: t("這個鏡頭的路線已不存在：在「方式」選一個方式") };
}

/** A route as lists show it: its name, the machine its DiT runs on (Node label without the hardware note), the full label. */
export interface RouteFace {
  name: string;
  /** The wiring part of the label (after 「：」); null when the label has none. */
  wiring: string | null;
  machine: string | null;
  /** Tooltip: the whole label. */
  title: string;
}

export function routeFace(route: StudioRoute, catalog: Catalog | undefined): RouteFace {
  const { name, description } = routeName(route.label);
  const node = route.ditNodeId ? indexCatalog(catalog).nodeLabel(route.ditNodeId) : null;
  return { name, wiring: description, machine: node ? nodeShortName(node) : null, title: route.label };
}
