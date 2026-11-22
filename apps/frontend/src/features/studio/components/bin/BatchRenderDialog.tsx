// 批次渲染 asks first (the shot list's toolbar, whenever its button would send more than one shot; one shot goes at once,
// as 渲染鏡頭 does): a running batch can only be cancelled as a whole, so this is where shots are left out. It lists the
// batch's shots in the order they would render, each with a checkbox (checked at first), its place in the film, its
// title, why it is in the batch (batchScope.batchReason: never rendered, what changed since its take, the last render
// failed, was cancelled or interrupted; a selected shot may also be up to date), its route and its estimate; a shot whose
// row reported why it cannot render is listed with the reason and cannot be checked. The footer has the total estimate
// and the finish time of the checked shots, both following the boxes, and 開始渲染 N 個鏡頭 sends exactly the checked
// shots, in this order, as one run (useStudio().renderShots).
// The rows are the toolbar's live batch: a shot that starts rendering elsewhere leaves, one that gets blocked shows why,
// and every shot that was not unchecked stays checked. Mounted once per opening (the toolbar keys it) and kept while it
// fades out; from the moment it closes it goes on showing the batch as it was (the shots it sent start rendering at
// once), so nothing in it changes on the way out. Each row's estimate is its time as part of the checked batch (a shot
// after another on the same route finds its components loaded), so the checked rows add up to the total; an unchecked
// row shows what it would add.
// Keyboard: the first checkbox has the focus; ↑↓, Home and End move between the rows, Space checks, Shift+click or
// Shift+Space checks or unchecks the range from the row used last; Ctrl/⌘+Enter starts, as Enter does on the primary
// button; Esc cancels. A click outside closes it only while nothing was unchecked. Motion: the shared dialog entrance and
// exit; the rows rise in one after another; a check pops in and a checked row's tint fades; the footer's estimate and the
// primary's count fade when they change; buttons press.
import { Check, Clapperboard, ListVideo, Route, TriangleAlert } from "lucide-react";
import { useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { useNow } from "@/lib/time";
import { useSegmentEstimates } from "../../hooks/usePlanEta";
import { useRenderEta } from "../../hooks/useRenderEta";
import { ETA_RISK_LABEL, formatEtaClock, segmentEtaText, shotEtaInput, type SegmentEta, type SegmentEtaInput } from "../../model/eta";
import { useProjectLanes } from "../../model/lanePrefs";
import { MIN_LANES } from "../../model/lanes";
import { findRoute, routeName, type StudioRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { ShotStatusMark } from "../marks";
import { EtaLine } from "../RenderEta";
import { batchReason, finishText, lanesLine, type BatchReason, type BatchScope, type BlockedShot } from "./batchScope";

export interface BatchRenderDialogProps {
  open: boolean;
  /** The toolbar's batch: its candidates in the order they would render, and whether they are the multi-selection. */
  scope: BatchScope;
  /** Candidates whose row reported why they cannot render (they cannot be checked). */
  blocked: readonly BlockedShot[];
  /** Place in the film (0-based) of the shots on the timeline. */
  positions: ReadonlyMap<string, number>;
  /** Why nothing can be sent now (another run, the engine, an export being sent); null when it can. */
  unavailable: string | null;
  onClose: () => void;
}

interface Row {
  shot: StudioShot;
  /** Why it cannot render (its row's report); null when it can be checked. */
  blocked: string | null;
  reason: BatchReason;
}

/** What the dialog shows: the live batch while it is open, the batch as it was once it closes. */
interface View {
  project: StudioProject;
  scope: BatchScope;
  blocked: readonly BlockedShot[];
  unavailable: string | null;
  now: number | null;
}

/** The checkboxes the arrow keys move between (a blocked row stays focusable, so its reason is read). */
const CHECKBOX = "input[data-batch-shot]";
/** A row's estimate: 「約 4:20」 (a memory risk adds a mark), 「…」 while the first answer is pending, 「—」 with why there is none. */
function RowEta({ id, eta, pending, checked }: { id: string; eta: SegmentEta | null | undefined; pending: boolean; checked: boolean }) {
  const usable = eta && eta.basis !== "unknown" && eta.basis !== "partial" ? eta : null;
  const title = usable?.risk ? `${segmentEtaText(usable)}\n${ETA_RISK_LABEL[usable.risk]}` : segmentEtaText(eta);
  return (
    <span id={id} title={title} className={cn("machine flex shrink-0 items-center justify-end gap-1 text-caption transition-colors duration-(--duration-fast)", checked ? "text-fg-secondary" : "text-fg-tertiary")}>
      {usable?.risk ? <TriangleAlert aria-hidden className={cn("size-3", usable.risk === "oom" ? "text-danger" : "text-warning")} /> : null}
      {usable ? t("約 {time}", { time: formatEtaClock(usable.seconds) }) : pending && eta === undefined ? "…" : "—"}
    </span>
  );
}

function BatchRow({
  row,
  route,
  index,
  position,
  checked,
  eta,
  pending,
  onToggle,
}: {
  row: Row;
  /** The shot's route; null when it no longer exists. */
  route: StudioRoute | null;
  /** Order of appearance (the entrance stagger). */
  index: number;
  /** Place in the film (0-based); undefined off the timeline. */
  position: number | undefined;
  checked: boolean;
  eta: SegmentEta | null | undefined;
  pending: boolean;
  onToggle: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = useId();
  const { shot, blocked, reason } = row;
  return (
    <label
      ref={reveal(index)}
      className={cn(
        // select-none: Shift+click checks a range instead of selecting the text between two rows
        "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5 select-none transition-colors duration-(--duration-fast) ease-standard has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-focus",
        blocked !== null ? "cursor-not-allowed" : checked ? "cursor-pointer bg-brand-soft/40 hover:bg-brand-soft/55 active:bg-sunken" : "cursor-pointer hover:bg-raised/60 active:bg-sunken",
      )}
    >
      <input
        type="checkbox"
        data-batch-shot=""
        checked={checked}
        aria-disabled={blocked !== null || undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={blocked === null ? `${id}-facts ${id}-eta` : `${id}-facts`}
        onChange={onToggle}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "grid size-4 place-items-center rounded-[5px] border transition-[background-color,border-color] duration-(--duration-fast)",
          blocked !== null ? "border-line-subtle bg-raised" : checked ? "border-transparent bg-action-gradient text-on-accent" : "border-line-control bg-sunken",
        )}
      >
        {checked ? <Check className="size-3 animate-pop-in" strokeWidth={3} /> : null}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span id={`${id}-title`} className="flex min-w-0 items-center gap-1.5 text-data">
          <span className="machine shrink-0 text-caption text-fg-tertiary">{position === undefined ? "––" : String(position + 1).padStart(2, "0")}</span>
          <span className={cn("truncate", blocked !== null ? "text-fg-tertiary" : "text-fg")}>{shot.title || t("未命名鏡頭")}</span>
        </span>
        <span id={`${id}-facts`} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-fg-tertiary">
          {blocked !== null ? (
            <span className="inline-flex min-w-0 items-start gap-1 text-warning [overflow-wrap:anywhere]">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {t("{label}：{detail}", { label: t("無法渲染"), detail: blocked })}
            </span>
          ) : (
            <>
              <ShotStatusMark status={reason.status} />
              {(reason.detail != null && reason.detail !== "") ? (
                <span title={reason.title ?? undefined} className="min-w-0 [overflow-wrap:anywhere]">
                  {reason.detail}
                </span>
              ) : null}
            </>
          )}
          <span title={route?.label ?? shot.route} className="inline-flex max-w-full min-w-0 items-center gap-1">
            <Route aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{route ? routeName(route.label).name : t("路由不存在")}</span>
          </span>
        </span>
      </span>
      {blocked === null ? <RowEta id={`${id}-eta`} eta={eta} pending={pending} checked={checked} /> : <span aria-hidden />}
    </label>
  );
}

export function BatchRenderDialog(props: BatchRenderDialogProps) {
  const { open, positions, onClose } = props;
  const studio = useStudio();
  const { engine, renderShots, busy } = studio;
  const lanes = useProjectLanes(studio.project.project_id);
  const contentRef = useRef<HTMLDivElement>(null);
  /** The row checked or unchecked last: Shift extends from it. */
  const anchorRef = useRef<string | null>(null);
  /** The shots the person unchecked; every other renderable candidate is checked (also one that appears meanwhile). */
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  /** The batch as it was when the dialog closed (shown while it fades out). */
  const [frozen, setFrozen] = useState<View | null>(null);
  const ticking = useNow(open && frozen === null, 30_000);
  const live: View = { project: studio.project, scope: props.scope, blocked: props.blocked, unavailable: props.unavailable, now: ticking };
  const { project, scope, blocked, unavailable, now } = frozen ?? live;

  const rows = useMemo(() => {
    const reasons = new Map(blocked.map((item) => [item.shot.shot_id, item.reason]));
    return scope.candidates.map((shot): Row => ({ shot, blocked: reasons.get(shot.shot_id) ?? null, reason: batchReason(shot, project) }));
  }, [blocked, project, scope.candidates]);
  const checkable = useMemo(() => rows.flatMap((row) => (row.blocked === null ? [row.shot] : [])), [rows]);
  const checked = useMemo(() => checkable.filter((shot) => !unchecked.has(shot.shot_id)), [checkable, unchecked]);

  // Each row's time as part of the checked batch: a shot after a checked one on the same route finds its components
  // loaded (as shotsEtaInputs counts them), an unchecked row is counted as if it were checked where it stands
  const inputs = useMemo(() => {
    const used = new Set<string>();
    return checkable.map((shot) => {
      const input = shotEtaInput(project, shot, findRoute(engine.routes, shot.route), used.has(shot.route));
      if (!unchecked.has(shot.shot_id)) used.add(shot.route);
      return input;
    });
  }, [checkable, engine.routes, project, unchecked]);
  const asked = useMemo(() => inputs.filter((input): input is SegmentEtaInput => input !== null), [inputs]);
  const estimates = useSegmentEstimates(asked);
  const etaByShot = useMemo(() => {
    const out = new Map<string, SegmentEta | null | undefined>();
    let at = 0;
    checkable.forEach((shot, index) => {
      if (inputs[index] === null) {
        out.set(shot.shot_id, null);
        return;
      }
      out.set(shot.shot_id, estimates.results?.[at]);
      at += 1;
    });
    return out;
  }, [checkable, estimates.results, inputs]);
  const plan = useRenderEta(checked);

  const count = checked.length;
  // Another run or the engine first (no box changes that), then what the boxes leave
  const reason =
    unavailable ??
    (rows.length === 0
      ? t("沒有要渲染的鏡頭")
      : checkable.length === 0
        ? t("沒有可以渲染的鏡頭：{count} 個被擋下", { count: rows.length })
        : count === 0
          ? t("勾選要渲染的鏡頭")
          : null);
  const finish = plan.eta && now !== null && count > 0 ? finishText(now + plan.eta.totalSeconds * 1000, now) : null;
  const lanesNote = lanes.length >= MIN_LANES && count > 0 ? lanesLine(engine.routes, lanes, count) : null;
  // Fades when what it says changes, not on every estimate request
  const statusRef = useChangeFade<HTMLDivElement>(`${String(count)}\n${String(plan.eta?.totalSeconds ?? "")}\n${finish ?? ""}\n${reason ?? ""}`);
  const labelRef = useChangeFade<HTMLSpanElement>(count);
  const shortcut = t("{key}+Enter 渲染・Esc 取消", { key: modifierLabel("Mod", detectApplePlatform()) });

  const toggle = (shotId: string) => (event: ChangeEvent<HTMLInputElement>) => {
    // Only a shot that can be checked (a blocked row's box stays unchecked)
    const to = checkable.findIndex((shot) => shot.shot_id === shotId);
    if (to < 0) return;
    const on = event.target.checked;
    const from = anchorRef.current === null ? -1 : checkable.findIndex((shot) => shot.shot_id === anchorRef.current);
    const range = event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey && from >= 0;
    const ids = range ? checkable.slice(Math.min(from, to), Math.max(from, to) + 1).map((shot) => shot.shot_id) : [shotId];
    anchorRef.current = shotId;
    setUnchecked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  const close = () => {
    setFrozen((current) => current ?? live);
    onClose();
  };
  const start = () => {
    if (reason !== null || busy === "render" || frozen !== null) return;
    void renderShots(checked.map((shot) => shot.shot_id));
    close();
  };
  /** ↑↓ Home End: the focus moves between the rows' checkboxes (Tab still goes through them, then on to the footer). */
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const boxes = [...event.currentTarget.querySelectorAll<HTMLInputElement>(CHECKBOX)];
    const at = boxes.findIndex((box) => box === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? boxes.length - 1 : Math.min(boxes.length - 1, Math.max(0, at + (event.key === "ArrowUp" ? -1 : 1)));
    const target = boxes[next];
    if (!target) return;
    event.preventDefault();
    target.focus();
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
        className="max-w-2xl"
        onOpenAutoFocus={(event) => {
          // The first shot that can be checked, so Space and the arrow keys work through the list right away
          const first = contentRef.current?.querySelector<HTMLInputElement>(`${CHECKBOX}:not([aria-disabled])`);
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onInteractOutside={(event) => {
          if (unchecked.size > 0) event.preventDefault();
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
            <ListVideo aria-hidden className="size-4 text-brand-cyan" />
            {t("批次渲染")}
            <span className="text-data font-normal text-fg-tertiary">{t("{count} 個鏡頭", { count: rows.length })}</span>
          </DialogTitle>
          <DialogDescription>
            {scope.selection
              ? t("選取的鏡頭會依清單順序放進同一個 run。送出後只能整批取消，不想現在渲染的鏡頭請先取消勾選。")
              : t("時間軸上需要（重新）渲染的鏡頭會依影片順序放進同一個 run。送出後只能整批取消，不想現在渲染的鏡頭請先取消勾選。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-1">
          {rows.length === 0 ? (
            <EmptyState size="compact" icon={<ListVideo />} title={t("沒有要渲染的鏡頭")} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 pb-1 text-caption">
                <Button size="sm" variant="quiet" className="min-h-7 px-2" onClick={() => { setUnchecked(new Set()); }}>
                  {t("全選")}
                </Button>
                <Button size="sm" variant="quiet" className="min-h-7 px-2" onClick={() => { setUnchecked(new Set(checkable.map((shot) => shot.shot_id))); }}>
                  {t("全不選")}
                </Button>
                <span className="machine ml-auto text-fg-tertiary">{t("已勾選 {count}／{total}", { count, total: checkable.length })}</span>
              </div>
              <div /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  role="group" aria-label={t("要渲染的鏡頭")} onKeyDown={moveFocus} className="grid gap-0.5">
                {rows.map((row, index) => (
                  <BatchRow
                    key={row.shot.shot_id}
                    row={row}
                    route={findRoute(engine.routes, row.shot.route)}
                    index={index}
                    position={positions.get(row.shot.shot_id)}
                    checked={row.blocked === null && !unchecked.has(row.shot.shot_id)}
                    eta={etaByShot.get(row.shot.shot_id)}
                    pending={estimates.pending}
                    onToggle={toggle(row.shot.shot_id)}
                  />
                ))}
              </div>
              {scope.skipped > 0 ? <p className="px-2 pt-1 text-caption text-fg-tertiary">{t("略過 {count} 個還沒有 prompt 或正在渲染的鏡頭", { count: scope.skipped })}</p> : null}
            </>
          )}
        </DialogBody>
        <DialogFooter className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-2">
          <div ref={statusRef} role="status" aria-live="polite" className="col-span-3 grid min-w-0 gap-0.5">
            {count > 0 ? (
              <>
                <EtaLine state={plan} />
                {(finish != null && finish !== "") ? <p className="pl-5 text-caption font-medium text-fg">{finish}</p> : null}
                {(lanesNote != null && lanesNote !== "") ? <p className="pl-5 text-caption text-fg-tertiary [overflow-wrap:anywhere]">{lanesNote}</p> : null}
              </>
            ) : null}
            {reason !== null && rows.length > 0 ? <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{reason}</p> : null}
          </div>
          <span className="min-w-0 truncate text-caption text-fg-tertiary">{shortcut}</span>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <ActionButton variant="primary" icon={<Clapperboard aria-hidden />} pending={busy === "render"} disabledReason={reason} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={start}>
            <span ref={labelRef}>{t("開始渲染 {count} 個鏡頭", { count })}</span>
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
