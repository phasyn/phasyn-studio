// 監看器（中間）：選取的 take——生成中顯示階段、步數與中間預覽（非最終結果）；完成顯示最終圖片（原圖或白底版，
// 背景可切棋盤格／白／黑，符合視窗或原始大小）；失敗顯示錯誤。可以和另一個 take 比較：並排，或以分隔線疊圖
// （拖曳或用滑桿／方向鍵移動分隔線），下方列出兩者的參數差異。專案還沒有圖片時，這裡是整個工作區唯一的空狀態
// （品牌時刻：three.js 極光，主要動作「新增圖片」）；背景與縮放只在有圖片可看時出現。
// Controls that leave with what they control (End Comparison, the progress view's Cancel) hand keyboard focus on to
// the compared take or this take's menu, and the cancel confirmation lives here so it outlasts the run it cancels.
import { ArrowLeftRight, Columns2, Ellipsis, ExternalLink, Maximize2, Minimize2, Plus, Sparkles, SquareSplitHorizontal, Star, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { WireRun } from "@/api/types";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { PANEL_RAISED } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { usePersistentChoice } from "@/lib/usePersistentSize";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { useImageStudio } from "../imageStudioContext";
import { activeImageTake, imageShots, takeNumber } from "../model/shots";
import type { ImageAsset, ImageStudioProject, StudioImageShot, StudioImageTake } from "../types";
import { BACKDROP_CLASS, BACKDROP_LABELS, type Backdrop } from "./display";
import { Segmented } from "./fields";
import { ImageStage, Wipe, type Zoom } from "./ImageStage";
import { TakeStateMark } from "./marks";
import { DiffTable, Facts } from "./TakeFacts";
import { TakeProgress } from "./TakeProgress";
import { useTakeActions } from "./useTakeActions";
import { t, tServer } from "@/i18n";

const BACKDROPS: readonly Backdrop[] = ["checker", "white", "black"];

function assetOf(take: StudioImageTake, variant: "image" | "white"): ImageAsset | null {
  return variant === "white" ? (take.image_white ?? take.image) : take.image;
}

function takeLabel(shot: StudioImageShot, take: StudioImageTake): string {
  return t("take {takeNumber}・seed {seed}", { takeNumber: takeNumber(shot, take.take_id), seed: take.seed });
}

/** A take's tile in the Takes gallery (TakesGallery marks its button with data-take-tile); null when not shown. */
function takeTile(takeId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-take-tile="${takeId}"]`);
}

/** What stops with the run: every image of its batch (finished ones are kept). */
function cancelScope(project: ImageStudioProject, runId: string): string {
  const count = imageShots(project).reduce((sum, shot) => sum + shot.takes.filter((item) => item.run_id === runId).length, 0);
  return count > 1
    ? t("取消整個 run {run_id}：批次的 {count} 張圖片都會停止。已經完成的圖片保留。", { run_id: runId.slice(0, 8), count })
    : t("取消整個 run {run_id}：這張圖片會停止。已經完成的圖片保留。", { run_id: runId.slice(0, 8) });
}

export function Viewer() {
  const { project, selectedShotId, selectedTakeId, compareTakeId, setCompareTakeId, addShot } = useImageStudio();
  const { menuItems } = useTakeActions();
  const menuId = useId();
  const toolsRef = useRef<HTMLDivElement>(null);
  // The run being confirmed for cancelling and the button that asked. The dialog lives here, not in the progress view,
  // so it stays open with its result after the run has ended and the progress view has left.
  const [cancelling, setCancelling] = useState<{ run: WireRun; opener: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; returnFocus: HTMLElement | null; focus: "first" | "last" } | null>(null);
  const [backdrop, setBackdrop] = usePersistentChoice<Backdrop>("imageStudio.viewer.backdrop", "checker", BACKDROPS);
  const [zoom, setZoom] = usePersistentChoice<Zoom>("imageStudio.viewer.zoom", "fit", ["fit", "actual"]);
  const [compareMode, setCompareMode] = usePersistentChoice<"side" | "wipe">("imageStudio.viewer.compare", "side", ["side", "wipe"]);
  const [variant, setVariant] = useState<"image" | "white">("image");
  const shot = imageShots(project).find((item) => item.image_shot_id === selectedShotId) ?? null;
  const take = shot?.takes.find((item) => item.take_id === selectedTakeId) ?? null;
  const other = shot && (compareTakeId != null && compareTakeId !== "") ? (shot.takes.find((item) => item.take_id === compareTakeId) ?? null) : null;
  const done = take?.state === "succeeded" && take.image !== null;
  const comparing = done && other !== null && other.take_id !== take.take_id && other.state === "succeeded" && other.image !== null;
  const assetA = done ? assetOf(take, variant) : null;
  const assetB = comparing ? assetOf(other, variant) : null;

  /** This take's menu button in the toolbar: focus goes there when the control that had it leaves the viewer. */
  const takeMenu = () => toolsRef.current?.querySelector<HTMLElement>('button[aria-haspopup="menu"]') ?? null;
  const focusTakeMenu = () => takeMenu()?.focus();
  const endCompare = () => {
    // End Comparison leaves with the comparison: focus goes to the compared take's tile (where the comparison was
    // started), else the monitored take's tile, else this take's menu; never to the page.
    const tile = ((compareTakeId != null && compareTakeId !== "") ? takeTile(compareTakeId) : null) ?? (take ? takeTile(take.take_id) : null);
    if (tile) tile.focus();
    else focusTakeMenu();
    setCompareTakeId(null);
  };
  const progressLeftWithFocus = () => {
    // Runs while React removes the progress view: move focus once it has fallen to the page, not before
    queueMicrotask(() => {
      if (document.activeElement === document.body) focusTakeMenu();
    });
  };

  let body: ReactNode;
  if (!shot) {
    body = (
      <div className="grid size-full place-items-center overflow-y-auto p-6">
        <EmptyState
          scene
          illustration="frames"
          title={t("還沒有圖片")}
          description={t("新增一張圖片，寫 prompt、選尺寸與 seed 後生成；結果會出現在這裡，也能一鍵用在影片鏡頭。")}
          action={
            <Button
              variant="primary"
              icon={<Plus aria-hidden />}
              onClick={() => {
                // 這顆按鈕會跟著空狀態消失：焦點交給新圖片在清單裡的那一列（清單收合時給設定面板目前的分頁）
                const shotId = addShot();
                requestAnimationFrame(() =>
                  (document.querySelector<HTMLElement>(`[data-image-row="${shotId}"]`) ?? document.querySelector<HTMLElement>('[role="tab"][id^="image-inspector-tab-"][aria-selected="true"]'))?.focus(),
                );
              }}
            >
              {t("新增圖片")}
            </Button>
          }
        />
      </div>
    );
  } else if (!take) {
    body = (
      <div className="grid size-full place-items-center overflow-y-auto p-6">
        <EmptyState
          icon={<Sparkles />}
          size="compact"
          title={t("「{value}」還沒有生成", { value: shot.title || t("未命名圖片") })}
          description={t("在右側寫 prompt、選尺寸與 seed，再按右上角的「生成圖片」；生成時這裡顯示進度與中間預覽。")}
        />
      </div>
    );
  } else if (take.state === "rendering") {
    body = <TakeProgress key={take.take_id} take={take} onCancel={(run, opener) => { setCancelling({ run, opener }); }} onFocusLeave={progressLeftWithFocus} />;
  } else if (!done || !assetA) {
    body = (
      <div className="grid size-full place-items-center overflow-y-auto p-6">
        <EmptyState
          illustration="offline"
          size="compact"
          title={<TakeStateMark state={take.state} className="text-body font-semibold [&_svg]:size-4" />}
          description={
            take.error ? (
              <span className={cn("[overflow-wrap:anywhere]", take.state === "cancelled" ? "text-fg-secondary" : "text-danger")}>
                <code className="machine">{take.error.code}</code>
                {` ${tServer(take.error.message)}`}
              </span>
            ) : (
              t("沒有錯誤訊息。")
            )
          }
          action={
            <Link to={`/records/runs/${encodeURIComponent(take.run_id)}`} className="inline-flex items-center gap-1 text-caption">
              <ExternalLink aria-hidden className="size-3.5" />
              {t("在「紀錄・執行紀錄」查看步驟與錯誤")}
            </Link>
          }
        />
      </div>
    );
  } else if (comparing && assetB) {
    body =
      compareMode === "wipe" ? (
        <Wipe a={assetA} b={assetB} labelA={takeLabel(shot, take)} labelB={takeLabel(shot, other)} backdrop={backdrop} />
      ) : (
        <div className="grid size-full min-h-0 grid-cols-2 gap-2 p-2">
          <ImageStage asset={assetA} alt={t("A：{takeLabel}", { takeLabel: takeLabel(shot, take) })} backdrop={backdrop} zoom={zoom} label={t("A・{takeLabel}", { takeLabel: takeLabel(shot, take) })} className="rounded-lg border border-line-subtle" />
          <ImageStage asset={assetB} alt={t("B：{takeLabel}", { takeLabel: takeLabel(shot, other) })} backdrop={backdrop} zoom={zoom} label={t("B・{takeLabel}", { takeLabel: takeLabel(shot, other) })} className="rounded-lg border border-line-subtle" />
        </div>
      );
  } else {
    body = <ImageStage asset={assetA} alt={t("「{title}」{takeLabel}", { title: shot.title, takeLabel: takeLabel(shot, take) })} backdrop={backdrop} zoom={zoom} />;
  }

  if (!shot) {
    return (
      <section aria-label={t("監看")} className={PANEL_RAISED}>
        <div className="relative min-h-0 flex-1 bg-stage">{body}</div>
      </section>
    );
  }

  return (
    <section aria-label={t("監看")} className={PANEL_RAISED}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-2.5">
        <span className="flex min-w-0 items-baseline gap-1.5 truncate text-data text-fg">
          <span className="truncate font-medium">{shot.title || t("未命名圖片")}</span>
          {take ? <span className="machine shrink-0 text-caption text-fg-tertiary">{takeLabel(shot, take)}</span> : null}
        </span>
        {take ? <TakeStateMark state={take.state} compact /> : null}
        {take && activeImageTake(shot)?.take_id === take.take_id ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-blue/40 bg-brand-gradient-soft px-2 text-caption text-fg">
            <Star aria-hidden className="size-3 text-brand-cyan" />
            {t("使用中")}
          </span>
        ) : null}
        <div ref={toolsRef} className="ml-auto flex min-w-0 items-center gap-1.5">
          {comparing ? (
            <>
              <Segmented
                name="image-compare-mode"
                label={t("比較方式")}
                value={compareMode}
                onChange={setCompareMode}
                options={[
                  { value: "side", label: t("並排"), icon: <Columns2 aria-hidden /> },
                  { value: "wipe", label: t("分隔"), icon: <SquareSplitHorizontal aria-hidden /> },
                ]}
              />
              <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<X aria-hidden />} onClick={endCompare}>
                {t("結束比較")}
              </Button>
            </>
          ) : null}
          {done && take.image_white ? (
            <Segmented
              name="image-variant"
              label={t("顯示原圖或白底版")}
              value={variant}
              onChange={setVariant}
              options={[
                { value: "image", label: t("原圖") },
                { value: "white", label: t("白底") },
              ]}
            />
          ) : null}
          {/* 背景與縮放只在有圖片可看時出現 */}
          {done ? (
            <>
              <Segmented
                name="image-backdrop"
                label={t("背景")}
                value={backdrop}
                onChange={setBackdrop}
                options={BACKDROPS.map((item) => ({
                  value: item,
                  // The swatch is decorative; the hidden text names the radio (a title on the label does not).
                  label: (
                    <>
                      <span aria-hidden className={cn("block size-3 rounded-[2px] border border-line", BACKDROP_CLASS[item])} />
                      <span className="sr-only">{BACKDROP_LABELS[item]}</span>
                    </>
                  ),
                  title: BACKDROP_LABELS[item],
                }))}
              />
              <Button
                size="icon-sm"
                variant="quiet"
                className="size-7"
                aria-pressed={zoom === "actual"}
                aria-label={zoom === "fit" ? t("原始大小（1:1）") : t("符合視窗")}
                title={zoom === "fit" ? t("原始大小（1:1，可捲動）") : t("符合視窗")}
                onClick={() => { setZoom(zoom === "fit" ? "actual" : "fit"); }}
              >
                {zoom === "fit" ? <Maximize2 aria-hidden /> : <Minimize2 aria-hidden />}
              </Button>
            </>
          ) : null}
          {take ? (
            <MenuTriggerButton menuId={menuId} open={menu !== null} label={t("這個 take 的動作")} onOpen={(element, focus) => { setMenu({ anchor: { kind: "element", element }, returnFocus: element, focus }); }} onClose={() => { setMenu(null); }} className="size-7 [&_svg]:size-4">
              <Ellipsis aria-hidden />
            </MenuTriggerButton>
          ) : null}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-stage">{body}</div>
      {comparing ? (
        <div className="shrink-0 border-t border-line-subtle bg-canvas pt-1.5">
          <p className="flex items-center gap-1.5 px-3 pb-1 text-caption text-fg-tertiary">
            <ArrowLeftRight aria-hidden className="size-3.5" />
            {t("參數差異（A＝監看中、B＝比較對象）")}
          </p>
          <DiffTable a={take} b={other} />
        </div>
      ) : take && done ? (
        <Facts take={take} />
      ) : null}
      {menu && take ? <ActionMenu id={menuId} label={t("這個 take 的動作")} items={menuItems(shot, take)} anchor={menu.anchor} returnFocus={menu.returnFocus} initialFocus={menu.focus} onClose={() => { setMenu(null); }} /> : null}
      {cancelling ? (
        <CancelRunDialog
          run={cancelling.run}
          open
          onOpenChange={(open) => { if (!(open)) { setCancelling(null); } }}
          scope={cancelScope(project, cancelling.run.run_id)}
          // Back to the cancel button while it is on the page; once the run has ended it has left with the progress
          // view, so focus goes to this take's menu instead of the page
          onCloseAutoFocus={(event) => { returnFocusOr(event, cancelling.opener, takeMenu()); }}
        />
      ) : null}
    </section>
  );
}
