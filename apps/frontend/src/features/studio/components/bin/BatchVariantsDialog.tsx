// 渲染變體… (the shot list's multi-selection, SelectionBar): the variants popover of one shot (VariationsControl.tsx)
// for every selected shot at once. One set of choices — Seed (each shot's own fixed seed, new random seeds, typed fixed
// seeds), 參考檔案 (one @ name by alias and kind: each shot's own file and library files of that kind) and 路線 (each
// shot's own route and other ready routes of their tasks) — makes 2–8 takes of each shot (model/variantBatch.ts on
// model/variants.ts), and every take of every shot goes into one batch run, each a take of its own shot with the
// popover's take records and badges. The list shows each selected shot in list order with its takes (what each one
// changes from the shot), or why it is skipped (no prompt, rendering, no such @ name, too few or too many takes, its
// render check); a chosen route a shot cannot try is named under it. The footer has the take count, the estimate and the
// finish time of the whole run, as 批次渲染 has; the run's step limit is checked before sending. While the Controller
// runs another run (or the engine cannot tell yet) the start button says why and the choices stay; nothing is queued.
// The dialog stays open while the run is sent and closes once it was; when sending fails it stays with the choices.
// Mounted once per opening (ShotList keys it) and kept through its exit animation: from the moment it sends or closes it
// goes on showing the shots as they were, so nothing in it changes on the way out.
// Layout: the shared dialog (max 88 vh, the body scrolls inside it); on a wide window the choices on the left and the
// takes on the right. Keyboard: the random-seed count has the focus; Ctrl/⌘+Enter renders; Esc cancels; a click outside
// does not close it once a choice was changed. Motion: the shared dialog entrance and exit; sections and rows rise in one
// after another; chips pop in; the footer's status and the primary's count fade when they change; buttons press.
import { Shuffle, TriangleAlert } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { useNow } from "@/lib/time";
import { useRenderEta } from "../../hooks/useRenderEta";
import { useProjectLanes } from "../../model/lanePrefs";
import { RANDOM_SEED } from "../../model/project";
import { engineUnavailable, routeDisplayLabel, routeName } from "../../model/routes";
import { batchVariantPlan, INITIAL_BATCH_CHOICES, variantRoutes, type BatchVariantChoices, type ShotVariantPlan } from "../../model/variantBatch";
import { comboBadge, variantCombos, variantShots } from "../../model/variants";
import { aliasGroups } from "../../references/batchReplace";
import { useStudio } from "../../studioContext";
import { EtaLine } from "../RenderEta";
import { BatchFileChoices, BatchRouteChoices, type BatchRouteOption } from "../variants/BatchVariantChoices";
import { SeedChoices } from "../variants/VariantChoices";
import { finishText } from "./batchScope";

export interface BatchVariantsDialogProps {
  /** The selected shots it was opened for (list order); read from the project on every render. */
  shotIds: readonly string[];
  open: boolean;
  /** Place in the film (0-based) of the shots on the timeline. */
  positions: ReadonlyMap<string, number>;
  onClose: () => void;
}

const NO_SHOTS: readonly StudioShot[] = [];

function ShotVariantRow({ item, index, position, routeLabel }: { item: ShotVariantPlan; index: number; position: number | undefined; routeLabel: (routeId: string) => string }) {
  const { shot, axes, skipped, unfitRoutes } = item;
  const combos = axes ? variantCombos(axes) : [];
  return (
    <li ref={reveal(index)} className="grid min-w-0 gap-1 rounded-md bg-canvas/40 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-data">
        <span className="machine shrink-0 text-caption text-fg-tertiary">{position === undefined ? "––" : String(position + 1).padStart(2, "0")}</span>
        <span className={cn("min-w-0 flex-1 truncate", skipped === null ? "text-fg" : "text-fg-tertiary")}>{shot.title || t("未命名鏡頭")}</span>
        <span className={cn("machine shrink-0 text-caption", skipped === null ? "text-fg-secondary" : "text-fg-tertiary")}>{skipped === null ? t("{count} 個 take", { count: combos.length }) : t("略過")}</span>
      </div>
      {skipped !== null ? (
        <p className="inline-flex min-w-0 items-start gap-1 text-caption text-warning [overflow-wrap:anywhere] animate-fade-in">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {skipped}
        </p>
      ) : axes ? (
        <ol aria-label={t("「{title}」的 take", { title: shot.title || t("未命名鏡頭") })} className="flex min-w-0 flex-wrap gap-1">
          {combos.map((combo, at) => {
            const badge = comboBadge(shot, axes, combo, routeLabel);
            return (
              <li
                key={`${combo.route}\n${combo.item?.item_id ?? ""}\n${String(combo.seed)}`}
                title={badge.text}
                className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-raised/60 px-1.5 py-px text-caption animate-pop-in"
              >
                <span className="machine shrink-0 font-semibold text-fg">{`#${String(shot.takes.length + at + 1)}`}</span>
                <span className={cn("min-w-0 truncate", badge.same ? "text-fg-tertiary" : "text-fg-secondary")}>{badge.text}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {unfitRoutes.length > 0 ? (
        <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{t("這個鏡頭不能用的路線不試：{routes}", { routes: formatList(unfitRoutes.map(routeLabel)) })}</p>
      ) : null}
    </li>
  );
}

export function BatchVariantsDialog({ shotIds, open, positions, onClose }: BatchVariantsDialogProps) {
  const studio = useStudio();
  const { engine, catalog, plugins, busy, runBlockedReason, renderVariantBatch } = studio;
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [choices, setChoices] = useState<BatchVariantChoices>(INITIAL_BATCH_CHOICES);
  const [pending, setPending] = useState(false);
  /** The project as it was when the run was sent or the dialog closed (shown while it fades out). */
  const [frozen, setFrozen] = useState<StudioProject | null>(null);
  const project = frozen ?? studio.project;
  const lanes = useProjectLanes(project.project_id);
  const now = useNow(open && frozen === null, 30_000);
  const library = useMemo(() => project.library ?? [], [project.library]);
  const shots = useMemo(() => {
    const byId = new Map(project.shots.map((shot) => [shot.shot_id, shot]));
    return shotIds.flatMap((shotId) => byId.get(shotId) ?? []);
  }, [project.shots, shotIds]);
  const groups = useMemo(() => aliasGroups(shots), [shots]);
  // The other routes any of the shots can try, in the engine's order, with how many of them can
  const routeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const shot of shots) for (const route of variantRoutes(shot, engine.routes, catalog).slice(1)) counts.set(route.id, (counts.get(route.id) ?? 0) + 1);
    return engine.routes.flatMap((route): BatchRouteOption[] => {
      const count = counts.get(route.id);
      return (count != null && Boolean(count)) ? [{ route, shots: count }] : [];
    });
  }, [shots, engine.routes, catalog]);
  const plan = useMemo(() => batchVariantPlan(project, shots, choices, { routes: engine.routes, catalog, plugins, lanes }), [project, shots, choices, engine.routes, catalog, plugins, lanes]);
  const included = useMemo(() => plan.shots.filter((item) => item.axes !== null), [plan]);
  const previews = useMemo(() => included.flatMap((item) => item.preview), [included]);
  const eta = useRenderEta(plan.problem === null ? previews : NO_SHOTS);
  const fixedSeeds = shots.filter((shot) => shot.seed !== RANDOM_SEED).length;
  const routeLabel = (routeId: string) => routeName(routeDisplayLabel(engine.routes, routeId)).name;

  const count = plan.takes;
  const skipped = plan.shots.length - included.length;
  // Another run, the engine or an export being sent first (no choice changes that), then what the choices leave
  const unavailable = runBlockedReason ?? engineUnavailable(engine) ?? (busy === "export" ? t("正在送出匯出請求") : null);
  const reason = unavailable ?? plan.problem;
  const finish = eta.eta && now !== null && reason === null ? finishText(now + eta.eta.totalSeconds * 1000, now) : null;
  const totals = t("{shotsCount} 個鏡頭共 {count} 個 take", { shotsCount: included.length, count });
  const statusRef = useChangeFade<HTMLDivElement>(`${String(count)}\n${String(eta.eta?.totalSeconds ?? "")}\n${finish ?? ""}\n${reason ?? ""}`);
  const labelRef = useChangeFade<HTMLSpanElement>(count);
  const shortcut = t("{key}+Enter 渲染・Esc 取消", { key: modifierLabel("Mod", detectApplePlatform()) });

  const close = () => {
    setFrozen((current) => current ?? studio.project);
    onClose();
  };
  const start = () => {
    if (reason !== null || pending || busy === "render" || frozen !== null) return;
    const groupsToSend = included.flatMap((item) => (item.axes ? [{ shotId: item.shot.shot_id, variants: variantShots(item.shot, item.axes) }] : []));
    // What the dialog shows stays as it is while the run is sent (the shots start rendering at once)
    setFrozen(studio.project);
    setPending(true);
    void renderVariantBatch(groupsToSend).then((sent) => {
      setPending(false);
      if (sent) onClose();
      else setFrozen(null);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        ref={contentRef}
        wide
        onOpenAutoFocus={(event) => {
          // The random-seed count, as in the popover
          const first = contentRef.current?.querySelector<HTMLElement>("[data-autofocus]");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onInteractOutside={(event) => {
          if (choices !== INITIAL_BATCH_CHOICES || pending) event.preventDefault();
        }}
        onKeyDown={(event) => {
          // The keys stay in the dialog: the shot list and the editor have their own
          event.stopPropagation();
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          start();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shuffle aria-hidden className="size-4 text-brand-cyan" />
            {t("渲染變體")}
            <span className="text-data font-normal text-fg-tertiary">{t("{count} 個鏡頭", { count: shots.length })}</span>
          </DialogTitle>
          <DialogDescription>
            {t("選取的鏡頭各自用同一組 seed、參考檔案與路線渲染變體：每一種都成為那個鏡頭的 take，全部放進同一個 run，送出後只能整批取消。鏡頭本身的設定不變；換檔案時，新檔案放不下原本的片段就用整段。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <SeedChoices
              own={fixedSeeds > 0 ? { label: t("每個鏡頭自己的 seed（{count} 個鏡頭是固定 seed）", { count: fixedSeeds }), seed: null } : null}
              ownMissing={t("選取的鏡頭 seed 都是每次隨機：用新的隨機 seed，或在下面輸入固定的 seed。")}
              choices={choices}
              onChange={setChoices}
            />
            {groups.length > 0 ? <BatchFileChoices choices={choices} onChange={setChoices} groups={groups} library={library} /> : null}
            {routeOptions.length > 0 ? <BatchRouteChoices choices={choices} onChange={setChoices} options={routeOptions} catalog={catalog} /> : null}
          </div>
          <section aria-labelledby={`${id}-list`} className="grid min-w-0 content-start gap-1.5">
            <h3 id={`${id}-list`} className="flex items-center gap-2 text-caption font-semibold text-fg-secondary">
              <span className="min-w-0 flex-1">{t("會渲染的 take")}</span>
              {skipped > 0 ? <span className="machine shrink-0 font-normal text-warning">{t("略過 {count} 個鏡頭", { count: skipped })}</span> : null}
            </h3>
            <ol className="grid gap-1">
              {plan.shots.map((item, index) => (
                <ShotVariantRow key={item.shot.shot_id} item={item} index={index} position={positions.get(item.shot.shot_id)} routeLabel={routeLabel} />
              ))}
            </ol>
          </section>
        </DialogBody>
        <DialogFooter className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-2">
          <div ref={statusRef} role="status" aria-live="polite" className="col-span-3 grid min-w-0 gap-0.5">
            {count > 0 ? <p className="text-caption font-medium text-fg">{totals}</p> : null}
            {count > 0 && reason === null ? (
              <>
                <EtaLine state={eta} />
                {(finish != null && finish !== "") ? <p className="pl-5 text-caption font-medium text-fg">{finish}</p> : null}
              </>
            ) : null}
            {reason !== null ? <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{reason}</p> : null}
          </div>
          <span className="min-w-0 truncate text-caption text-fg-tertiary">{shortcut}</span>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <ActionButton
            variant="primary"
            icon={<Shuffle aria-hidden />}
            pending={pending || busy === "render"}
            disabledReason={reason}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={start}
          >
            <span ref={labelRef}>{t("渲染 {count} 個變體", { count })}</span>
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
