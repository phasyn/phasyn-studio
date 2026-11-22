// The bar of a multi-selection (40 px, between the toolbar and the list): how many shots are selected, their length and
// their route for all of them at once (each choice is one document edit, saved once: hooks/useShotsEdit.ts, which the
// engine sheet's 路線 tab shares; a route goes to the shots whose first frame fits it, and one none of them can use is
// unavailable with the reason), 渲染變體… (a dialog: every selected shot rendered as variants of the same seeds, file and
// routes in one run, BatchVariantsDialog), 換參考檔案… (a dialog: the files behind their @ names, BatchReplaceDialog;
// unavailable while none of them has a reference), duplicate, delete (asks first) and 清除 (only the current shot stays
// selected). Rendering them once each is the toolbar's 「渲染選取的 N 個」, so the bar does not repeat it. When the panel is narrow the last
// four buttons show their icons only, and narrower still the count shrinks to an icon and the number (measured, so every
// language fits). The bar grows in and out on the smooth spring; while it leaves it is inert.
import { Check, ChevronDown, Copy, ListChecks, Replace, Shuffle, Trash2, X, type LucideIcon } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { useId, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import type { MenuAnchor, MenuItem } from "@/components/ui/menuModel";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useFitLevel } from "@/lib/useFitLevel";
import { t } from "@/i18n";
import { routeUnfitReason, useShotsEdit } from "../../hooks/useShotsEdit";
import { formatDuration, frameOptions } from "../../model/frames";
import { FrameCountInput } from "../generation/FrameCountInput";
import { frameLimits } from "../../model/studioGenerationBinding";
import { engineUnavailable, findRoute, routeName } from "../../model/routes";
import { useStudio } from "../../studioContext";

/** The value every shot shares; null when they differ. */
function shared<T>(shots: readonly StudioShot[], value: (shot: StudioShot) => T): T | null {
  const first = shots[0];
  return first !== undefined && shots.every((shot) => value(shot) === value(first)) ? value(first) : null;
}

const TRIGGER = "h-7 gap-0.5 px-1 text-caption font-medium text-fg-secondary [&_svg]:size-3";
const BAR_BUTTON =
  "pressable inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-caption text-fg-secondary hover:bg-raised hover:text-fg active:bg-sunken [&_svg]:size-3.5";

interface OpenMenu {
  kind: "frames" | "route";
  anchor: MenuAnchor;
  returnFocus: HTMLElement;
  focus: "first" | "last";
}

/** A bar button; with a reason it stays focusable but does nothing (the reason is in its tooltip and its description). */
function BarButton({
  icon: Icon,
  label,
  compact,
  danger = false,
  disabledReason = null,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  compact: boolean;
  danger?: boolean;
  disabledReason?: string | null;
  onClick: () => void;
}) {
  const reasonId = useId();
  const blocked = disabledReason !== null;
  return (
    <>
      <button
        type="button"
        onClick={blocked ? undefined : onClick}
        aria-label={compact ? label : undefined}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? reasonId : undefined}
        title={disabledReason === null ? label : t("{label}：{detail}", { label, detail: disabledReason })}
        className={cn(
          BAR_BUTTON,
          danger && "text-danger hover:bg-danger/12 hover:text-danger",
          blocked && "cursor-not-allowed text-fg-disabled hover:bg-transparent hover:text-fg-disabled active:bg-transparent",
        )}
      >
        <Icon aria-hidden />
        {compact ? null : <span>{label}</span>}
      </button>
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}

export interface SelectionBarProps {
  /** The selected shots in list order (two or more). */
  shots: readonly StudioShot[];
  /** Opens 渲染變體 for the selected shots. */
  onRenderVariants: () => void;
  /** Opens 換參考檔案 for the selected shots. */
  onReplaceReferences: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({ shots, onRenderVariants, onReplaceReferences, onDuplicate, onDelete, onClear }: SelectionBarProps) {
  const { engine, project } = useStudio();
  const [durationOpen, setDurationOpen] = useState(false);
  const limits = frameLimits(shots.map((shot) => findRoute(engine.routes, shot.route)));
  const edit = useShotsEdit();
  const exiting = !useIsPresent();
  const menuId = useId();
  const reasonId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // Level 1: the buttons on the right show their icons only; level 2: the count shrinks to an icon and the number
  const level = useFitLevel(barRef, 2, shots.length);
  const compact = level > 0;
  const selectedLabel = t("已選取 {count} 個", { count: shots.length });
  const noReferences = shots.some((shot) => (shot.references?.length ?? 0) > 0) ? null : t("選取的鏡頭都沒有參考素材");
  const unavailable = engineUnavailable(engine) ?? (engine.routes.length === 0 ? t("還沒有可用於 Video Studio 的元件組合") : null);
  const open = (kind: OpenMenu["kind"]) => (element: HTMLButtonElement, focus: "first" | "last") => { setMenu({ kind, anchor: { kind: "element", element }, returnFocus: element, focus }); };

  const framesShared = shared(shots, (shot) => shot.frames);
  const routeShared = shared(shots, (shot) => shot.route);
  const items: MenuItem[] =
    menu?.kind === "frames"
      ? frameOptions().filter(limits.allows).map((frames) => ({
          id: `frames-${String(frames)}`,
          label: t("{frames}（{frames2} 影格）", { frames: formatDuration(frames, project.format.fps.num / project.format.fps.den), frames2: frames }),
          ...(frames === framesShared ? { icon: Check } : {}),
          onSelect: () => { edit.setFrames(shots, frames); },
        }))
      // Edit-tool routes (延展, 重繪, 控制) are not shot routes: they are not offered here
      : engine.routes.filter((route) => route.renderable).map((route) => {
          const name = routeName(route.label).name;
          return {
            id: `route-${route.id}`,
            label: route.ready ? name : t("{name}（未就緒）", { name }),
            ...(route.id === routeShared ? { icon: Check } : {}),
            disabledReason: routeUnfitReason(shots, route),
            onSelect: () => { edit.setRoute(shots, route); },
          };
        });

  return (
    <>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 40, opacity: 1 }}
        exit={{ height: 0, opacity: 0, transition: motionTransition("exit", "exit") }}
        transition={motionTransition("spring-smooth", "spring-smooth")}
        inert={exiting}
        aria-hidden={exiting || undefined}
        className="shrink-0 overflow-hidden border-b border-line-subtle bg-brand-gradient-soft"
      >
        <div ref={barRef} role="toolbar" aria-label={t("選取的鏡頭")} className="flex h-10 min-w-0 items-center gap-0.5 px-1.5">
          {level > 1 ? (
            <span title={selectedLabel} className="mr-0.5 inline-flex shrink-0 items-center gap-1 pl-0.5 text-caption font-medium whitespace-nowrap text-fg">
              <ListChecks aria-hidden className="size-3.5 text-brand-cyan" />
              <span aria-hidden className="machine">
                {shots.length}
              </span>
              <span className="sr-only">{selectedLabel}</span>
            </span>
          ) : (
            <span className="mr-0.5 shrink-0 pl-0.5 text-caption font-medium whitespace-nowrap text-fg">{selectedLabel}</span>
          )}
          {limits.h3 ? (
            <MenuTriggerButton menuId={menuId} open={menu?.kind === "frames"} label={t("把選取的鏡頭改成同一個時長")} onOpen={open("frames")} onClose={() => { setMenu(null); }} className={TRIGGER}>
              <span>{t("時長")}</span>
              <ChevronDown aria-hidden />
            </MenuTriggerButton>
          ) : (
            <Dialog open={durationOpen} onOpenChange={setDurationOpen}>
              <DialogTrigger asChild>
                <button type="button" className={cn(BAR_BUTTON, TRIGGER)} aria-label={t("把選取的鏡頭改成同一個時長")}>
                  {t("時長")}<ChevronDown aria-hidden />
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>{t("把選取的鏡頭改成同一個時長")}</DialogTitle></DialogHeader>
                <DialogBody><FrameCountInput initial={framesShared} limits={limits} onApply={(frames) => { edit.setFrames(shots, frames); setDurationOpen(false); }} /></DialogBody>
              </DialogContent>
            </Dialog>
          )}
          {(unavailable != null && unavailable !== "") ? (
            <button type="button" aria-disabled aria-describedby={reasonId} title={unavailable} className={cn("inline-flex shrink-0 cursor-not-allowed items-center rounded-md text-fg-disabled", TRIGGER)}>
              <span>{t("路線")}</span>
              <ChevronDown aria-hidden />
              <span id={reasonId} className="sr-only">
                {unavailable}
              </span>
            </button>
          ) : (
            <MenuTriggerButton menuId={menuId} open={menu?.kind === "route"} label={t("把選取的鏡頭改用同一條路線")} onOpen={open("route")} onClose={() => { setMenu(null); }} className={TRIGGER}>
              <span>{t("路線")}</span>
              <ChevronDown aria-hidden />
            </MenuTriggerButton>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <BarButton icon={Shuffle} label={t("渲染變體…")} compact={compact} onClick={onRenderVariants} />
            <BarButton icon={Replace} label={t("換參考檔案…")} compact={compact} disabledReason={noReferences} onClick={onReplaceReferences} />
            <BarButton icon={Copy} label={t("複製")} compact={compact} onClick={onDuplicate} />
            <BarButton icon={Trash2} label={t("刪除…")} compact={compact} danger onClick={onDelete} />
            <BarButton icon={X} label={t("清除")} compact={compact} onClick={onClear} />
          </span>
        </div>
      </motion.div>
      {menu ? (
        <ActionMenu
          key={menu.kind}
          id={menuId}
          label={menu.kind === "frames" ? t("時長") : t("路線")}
          items={items}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          initialFocus={menu.focus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
    </>
  );
}
