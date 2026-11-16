// Image Studio 的工作區（與 Video Studio 同樣的浮動面板）：圖片清單／紀錄 | 監看器＋take 清單 | 設定。分隔線可拖曳、
// 雙擊還原或用方向鍵調整；左右面板可收合成窄軌、take 清單可收合成標題列，尺寸與收合狀態記在這台瀏覽器。
// 專案還沒有圖片時只有一個空狀態：主區（監看器）顯示它，左欄只留「新增圖片」，設定面板與 take 清單不出現（記住的收合狀態
// 不變）；第一張圖片加入時它們從所在的邊緣滑入。
import { useRef } from "react";
import { usePersistentFlag, usePersistentSize } from "@/lib/usePersistentSize";
import { Splitter } from "@/components/workbench/Splitter";
import { CollapsedRail } from "@/features/studio-shell";
import { useElementSize } from "@/lib/useElementSize";
import { useImageStudio } from "../imageStudioContext";
import { imageShots } from "../model/shots";
import { Inspector } from "./Inspector";
import { PANEL_NAMES } from "./panels";
import { ShotsPanel } from "./ShotsPanel";
import { TakesGallery } from "./TakesGallery";
import { Viewer } from "./Viewer";
import { t } from "@/i18n";

const LEFT_DEFAULT = 272;
const RIGHT_DEFAULT = 380;
const GALLERY_DEFAULT = 200;
const GALLERY_MIN = 120;
/** Width of the rail a collapsed side panel leaves (as in Video Studio). */
const RAIL = "2.5rem";

export function Workspace() {
  const { project } = useImageStudio();
  const hasImages = imageShots(project).length > 0;
  const centerRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(centerRef);
  const [left, setLeft] = usePersistentSize("imageStudio.left", LEFT_DEFAULT, 220, 420);
  const [right, setRight] = usePersistentSize("imageStudio.right", RIGHT_DEFAULT, 320, 560);
  const [storedGallery, setGallery] = usePersistentSize("imageStudio.gallery", GALLERY_DEFAULT, GALLERY_MIN, 2000);
  const [leftOpen, setLeftOpen] = usePersistentFlag("imageStudio.left.open", true);
  const [rightOpen, setRightOpen] = usePersistentFlag("imageStudio.right.open", true);
  const [galleryOpen, setGalleryOpen] = usePersistentFlag("imageStudio.gallery.open", true);
  // 監看器至少留 200 px；視窗變矮時顯示夾住的值，變回高時還原
  const galleryMax = Math.max(GALLERY_MIN, height - 200);
  const gallery = Math.min(storedGallery, galleryMax);
  const leftColumn = leftOpen ? `${left}px` : RAIL;
  const columns = hasImages ? `${leftColumn} auto minmax(0,1fr) auto ${rightOpen ? `${right}px` : RAIL}` : `${leftColumn} auto minmax(0,1fr)`;
  const rows = !hasImages ? "minmax(0,1fr)" : galleryOpen ? `minmax(0,1fr) auto ${gallery}px` : "minmax(0,1fr) auto auto";
  return (
    <div className="grid min-h-0 flex-1 px-1.5 pb-1.5" style={{ gridTemplateColumns: columns }}>
      {leftOpen ? <ShotsPanel onCollapse={() => setLeftOpen(false)} /> : <CollapsedRail side="left" label={PANEL_NAMES.shots} onExpand={() => setLeftOpen(true)} />}
      {leftOpen ? (
        <Splitter grip="always" orientation="vertical" value={left} min={220} max={420} defaultValue={LEFT_DEFAULT} onChange={setLeft} label={t("調整圖片面板寬度")} />
      ) : (
        <div aria-hidden className="w-1.5" />
      )}
      <div ref={centerRef} className="grid min-h-0 min-w-0" style={{ gridTemplateRows: rows }}>
        <Viewer />
        {hasImages ? (
          <>
            {galleryOpen ? (
              <Splitter
                grip="always"
                orientation="horizontal"
                value={gallery}
                min={GALLERY_MIN}
                max={galleryMax}
                defaultValue={GALLERY_DEFAULT}
                onChange={(next) => setGallery(Math.min(next, galleryMax))}
                label={t("調整 take 清單高度")}
                invert
              />
            ) : (
              <div aria-hidden className="h-1.5" />
            )}
            <TakesGallery collapsed={!galleryOpen} onToggleCollapsed={() => setGalleryOpen(!galleryOpen)} />
          </>
        ) : null}
      </div>
      {hasImages ? (
        <>
          {rightOpen ? (
            <Splitter grip="always" orientation="vertical" value={right} min={320} max={560} defaultValue={RIGHT_DEFAULT} onChange={setRight} label={t("調整設定面板寬度")} invert />
          ) : (
            <div aria-hidden className="w-1.5" />
          )}
          {rightOpen ? <Inspector onCollapse={() => setRightOpen(false)} /> : <CollapsedRail side="right" label={PANEL_NAMES.inspector} onExpand={() => setRightOpen(true)} />}
        </>
      ) : null}
    </div>
  );
}
