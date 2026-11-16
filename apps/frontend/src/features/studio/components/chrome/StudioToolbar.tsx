// Video Studio's toolbar in three columns: left the project menu and the asset-library button; centred the workspace
// switcher (three peer views, not steps: a segmented control whose current view is a raised pill with the sliding brand
// indicator under its label; the render tab counts this project's running renders and, while one runs, opens on it);
// right the format, the face-swap launcher and, as one group, the running render's capsule, the render-shot button (the
// toolbar's one brand-gradient action) and the engine button with the current route.
// Narrower than its content (measured, so it holds for any language and project title; useFitLevel), the toolbar makes
// room in steps: 1 = the render capsule keeps only its arc and time left; 2 = the switcher stops being centred on the
// whole bar (the side columns take their own width and the switcher centres in the space between them) and the
// face-swap button keeps only its icon (its name stays in aria-label and the tooltip); 3 = the engine button keeps only
// its readiness dot and an icon, once its label no longer fits whole (measureToolbar counts a cut label as overflow, so
// the bar never shows half a word); 4 = the face-swap progress text and the render button's fix label go too (both stay
// in the tooltip and the accessible name). The asset-library and render-shot buttons always keep their labels. Below level 2
// every item keeps its natural width, so a shortfall shows up as an overflow to measure; from level 2 the project title
// may truncate.
// The running render ticks every second: only the leaves that show it read it (the capsule, the render tab's link, the
// alerts), so the rest of the toolbar does not render again with it. Visually hidden text stays in the accessible names.
import { Cpu } from "lucide-react";
import { memo, useRef } from "react";
import { NavLink, useSearchParams } from "react-router";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { Button } from "@/components/ui/button";
import { StableLabel } from "@/components/ui/stable-label";
import { cn } from "@/lib/cn";
import type { FitMeasure } from "@/lib/fitLevel";
import { measureOverflow, useFitLevel } from "@/lib/useFitLevel";
import { renderTaskCount } from "../../model/project";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { SwapLauncher } from "../../swap/SwapLauncher";
import { STUDIO_WORKSPACES } from "../../workspaces";
import { AssetLibraryButton, AssetLibraryHost } from "../library/AssetLibrary";
import { RenderShotControl } from "../RenderShotControl";
import { ReadyDot } from "../routeParts";
import { engineSummary, useCurrentRoute } from "./currentRoute";
import { ProjectMenu } from "./ProjectMenu";
import { RenderCapsule } from "./RenderCapsule";
import { useRenderAlerts } from "./renderAlerts";
import { t } from "@/i18n";

const TOOLBAR_FIT_LEVELS = 4;
/** From this level the engine button keeps only its readiness dot and an icon. */
const ENGINE_ICON = 3;
/** From this level the side columns take their own width and may shrink (the project title, then the engine label). */
const SIDES_SHRINK = 2;

/** How far a side's items reach past its own box (a justify-end row that is too narrow pushes them out on the left). */
function contentSpill(side: HTMLElement): number {
  const items = Array.from(side.children).flatMap((child) => (getComputedStyle(child).display === "contents" ? Array.from(child.children) : [child]));
  const box = side.getBoundingClientRect();
  let left = box.left;
  let right = box.right;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.width === 0) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return box.left - left + (right - box.right);
}

/**
 * The toolbar's overflow. Below level 2 the side columns are fixed 1fr tracks, so what does not fit spills out of its
 * column (under the centred switcher) without widening anything measureOverflow sees: each side's content box
 * (data-fit-watch, as wide as its content there) counts with what it exceeds its column by, and from level 2, where
 * that box follows its column, with how far its items reach past it. An engine label cut short
 * also counts, so the toolbar then steps to the icon-only button.
 */
function measureToolbar(element: HTMLElement): FitMeasure {
  const base = measureOverflow(element);
  let spill = 0;
  for (const side of element.querySelectorAll<HTMLElement>("[data-fit-watch]")) {
    const column = side.parentElement;
    if (column) spill += Math.max(0, side.offsetWidth - column.clientWidth) + contentSpill(side);
  }
  const label = element.querySelector<HTMLElement>("[data-fit-label]");
  const cut = label ? Math.max(0, label.scrollWidth - label.clientWidth) : 0;
  const extra = spill + (cut > 1 ? cut : 0);
  return extra > 1 ? { required: Math.max(base.required, base.available + extra), available: base.available } : base;
}

/** The current workspace: a raised pill with an inner frame (the brand indicator slides under it). */
const PILL_CURRENT = "bg-raised text-fg shadow-edge ring-1 ring-line-strong ring-inset [&_svg]:text-brand-cyan";
const PILL_IDLE = "text-fg-secondary hover:bg-raised/60 hover:text-fg";

const WorkspaceTabs = memo(function WorkspaceTabs({ projectId, runId }: { projectId: string; runId: string | null }) {
  const { project } = useStudio();
  const [params] = useSearchParams();
  const navRef = useRef<HTMLElement>(null);
  // The selected shot travels with the tab: the other workspace opens on the same shot (and its clip)
  const shot = params.get("shot");
  const search = `?project=${encodeURIComponent(projectId)}${shot ? `&shot=${encodeURIComponent(shot)}` : ""}`;
  // While this project's render runs, the render workspace opens on it
  const runSearch = runId ? `&run=${encodeURIComponent(runId)}` : "";
  const tasks = renderTaskCount(project);
  return (
    // 工作區：三個並列的檢視（不是先後步驟），置中的分段按鈕；aria-current＝目前的工作區，底下的品牌指示線滑到它。
    // 標籤不換行：中文可以逐字換行，分段按鈕的最小寬度會小於實際寬度，工具列最窄時中間欄被壓窄，「渲染」連同進行中的數字
    // 會凸出外框；不換行時中間欄至少是整組按鈕的寬度，改由兩側的專案標題與引擎按鈕截斷
    <nav
      ref={navRef}
      aria-label={t("Video Studio 工作區")}
      className="relative flex h-10 shrink-0 items-center gap-1 rounded-full border border-line-subtle bg-sunken/60 p-[3px] whitespace-nowrap"
    >
      {STUDIO_WORKSPACES.map((item) => (
        <NavLink
          key={item.id}
          to={`/studio/${item.id}${search}${item.badge === "renders" ? runSearch : ""}`}
          title={item.hint}
          className={({ isActive }) =>
            cn("pressable relative flex h-8 shrink-0 items-center gap-2 rounded-full px-4 text-body font-medium no-underline [&_svg]:size-4", isActive ? PILL_CURRENT : PILL_IDLE)
          }
        >
          <item.icon aria-hidden />
          <StableLabel weight="medium">{item.label}</StableLabel>
          {item.badge === "renders" && tasks > 0 ? (
            <span title={t("{tasks} 個渲染進行中", { tasks })} className="inline-flex min-w-4.5 items-center justify-center rounded-full border border-info/40 bg-info/12 px-1.5 text-[11px] leading-4 font-medium text-info">
              <span aria-hidden className="machine">
                {tasks}
              </span>
              {/* 螢幕閱讀器讀完整的一句（數字與量詞一起翻譯，英文才有單複數） */}
              <span className="sr-only">{t("{tasks} 個渲染進行中", { tasks })}</span>
            </span>
          ) : null}
        </NavLink>
      ))}
      {/* Under the current pill's label (its flat bottom edge), sliding on the snappy spring when the workspace changes */}
      <ActiveIndicator container={navRef} edge="bottom" inset={18} className="bottom-1" />
    </nav>
  );
});

/** The switcher with the running render's id (the only part of the activity it needs, so it re-renders only when that changes). */
function LiveWorkspaceTabs({ projectId }: { projectId: string }) {
  const runId = useRenderActivity()?.run.run_id ?? null;
  return <WorkspaceTabs projectId={projectId} runId={runId} />;
}

/** Tab title and browser notification of this project's render (renderAlerts.ts); renders nothing. */
function RenderAlerts() {
  useRenderAlerts();
  return null;
}

export function StudioToolbar({ workspace }: { workspace: string }) {
  const { project, setEngineOpen } = useStudio();
  const { route, engine } = useCurrentRoute();
  const summary = engineSummary(engine, route);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const renderButtonRef = useRef<HTMLButtonElement>(null);
  const fit = useFitLevel(toolbarRef, TOOLBAR_FIT_LEVELS, `${project.title}\u0000${route?.label ?? ""}\u0000${summary.text}\u0000${renderTaskCount(project)}`, measureToolbar);
  return (
    <div
      ref={toolbarRef}
      data-fit={fit}
      className={cn(
        "grid h-14 shrink-0 items-center gap-3 px-3",
        fit < SIDES_SHRINK ? "grid-cols-[1fr_auto_1fr] *:shrink-0" : "grid-cols-[minmax(0,auto)_1fr_minmax(0,auto)] [&>nav]:justify-self-center",
      )}
    >
      {/* 第 2 級之前左右兩欄的內容都不縮，內容盒（data-fit-watch）跟著內容寬：超出欄位的部分算進溢出（measureToolbar），
          不會跑到中間的分段按鈕底下；第 2 級起欄寬跟著內容，專案標題與引擎按鈕才可以截斷 */}
      <div className="flex min-w-0 items-center">
        <div data-fit-watch className={cn("flex items-center gap-3", fit < SIDES_SHRINK ? "w-max *:shrink-0" : "min-w-0")}>
          <ProjectMenu workspace={workspace} />
          {/* 素材庫：大按鈕，一直顯示文字。素材庫對話框掛在這裡（每個工作區都能開啟，關閉後保留篩選與捲動位置） */}
          <span aria-hidden className="h-6 w-px shrink-0 bg-line-subtle" />
          <AssetLibraryButton />
          <AssetLibraryHost />
        </div>
      </div>
      <LiveWorkspaceTabs projectId={project.project_id} />
      <div className="flex min-w-0 items-center justify-end">
        <div data-fit-watch className={cn("flex items-center justify-end gap-2.5", fit < SIDES_SHRINK ? "w-max *:shrink-0" : "min-w-0")}>
          <span className="machine hidden text-caption whitespace-nowrap text-fg-tertiary min-[1560px]:inline">
            {t("{width}×{height}・{num} fps", { width: project.format.width, height: project.format.height, num: project.format.fps.num / project.format.fps.den })}
          </span>
          {/* 一鍵換角：換角專案顯示進度；對話框關著也會在全部段落完成後自動匯出一次 */}
          <SwapLauncher iconOnly={fit >= SIDES_SHRINK} bare={fit >= TOOLBAR_FIT_LEVELS} />
          {/* 進行中的渲染：緊貼在「渲染鏡頭」左邊；第 1 級起只留進度弧與剩餘時間 */}
          <RenderCapsule compact={fit >= 1} fallbackFocus={renderButtonRef} />
          {/* 渲染鏡頭：緊貼在「渲染引擎」左邊的大按鈕，一直顯示文字（不縮；第 2 級時只有引擎按鈕可以截斷） */}
          <RenderShotControl buttonRef={renderButtonRef} compact={fit >= TOOLBAR_FIT_LEVELS} />
          <Button size="md" variant="secondary" onClick={() => setEngineOpen(true)} title={t("查看與啟動元件組合需要的元件\n目前鏡頭的路由：{title}", { title: summary.title })} className="min-w-0 shrink">
            <ReadyDot ready={summary.ready} />
            {fit >= ENGINE_ICON ? (
              <>
                <Cpu aria-hidden />
                <span className="sr-only">{t("渲染引擎")}</span>
              </>
            ) : (
              <span data-fit-label className="truncate">
                {t("渲染引擎")}
              </span>
            )}
            <span className="sr-only">
              {route ? t("{label}・", { label: route.label }) : ""}
              {summary.text}
            </span>
          </Button>
        </div>
      </div>
      <RenderAlerts />
    </div>
  );
}
