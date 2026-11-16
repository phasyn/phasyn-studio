// The engine sheet's 路線 tab: every route (saved component combination) in a compact list, grouped by the 方式 it
// serves — name, task, the machine its DiT runs on, state, and this shot's estimated render time on it. The shot's
// route is the chosen row; choosing another row pins that route for the shot. Routes of another 方式 are listed but
// cannot be chosen here (the 方式, in the generation row, sets the first frame together with the route); their
// components can still be shown. Names are the part before the first 「：」 outside brackets of a label, shown whole
// (they wrap instead of being cut, since long names often differ only at the end); the full label is the row's tooltip.
// While the shot list has a multi-selection the tab acts on the selected shots instead, as the selection bar's 路線
// does (hooks/useShotsEdit.ts): a note says so, the chosen row is the route they all share (none when they differ),
// choosing a row moves every selected shot whose first frame fits it in one document edit, a group none of them can
// use cannot be chosen and one only some of them can use says how many it changes, and the time is theirs together.
// Rows are at least 44 px; a route with a caveat (a DiT of fewer than 4 steps) shows it under its name inside the same row.
// Native radios (arrow keys move and choose, like the old route cards).
import { Cpu, ListChecks, TriangleAlert } from "lucide-react";
import { useId } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED, RISE_IN } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { useSegmentEstimates } from "../../hooks/usePlanEta";
import { taskUnfitReason, useShotsEdit } from "../../hooks/useShotsEdit";
import { formatEtaClock, planEta, planEtaText, segmentEtaText, shotsEtaInputs, type PlanEta, type SegmentEtaInput } from "../../model/eta";
import { shotFitsTask } from "../../model/generationMode";
import { findRoute, type RouteTask, type StudioRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { CapabilityBadge, ReadyDot, RouteCaveatLine } from "../routeParts";
import { routeFace } from "./modeText";

interface Group {
  task: RouteTask;
  label: string;
  /** Why none of the shots can use the group's routes; null = they can (all, or `fit` of them). */
  blocked: string | null;
  /** How many of the shots the group's routes can take (their first frame fits). */
  fit: number;
}

const TASKS: readonly RouteTask[] = ["ref2va", "fl2va", "t2va"];

function groupLabel(task: RouteTask): string {
  return task === "ref2va" ? t("參考素材") : task === "fl2va" ? t("首幀：接續上一鏡、首幀圖片") : t("只用文字");
}

/** Why one shot cannot use routes of `task` (its first-frame setting needs the other kind). */
function shotUnfitReason(task: RouteTask): string {
  return task === "fl2va"
    ? t("這些路線需要首幀：要用它們，先在生成列把方式改成「接續上一鏡」或「首幀圖片」")
    : t("這個鏡頭用首幀：要用這些路線，先在生成列把方式改成「參考素材」或「只用文字」");
}

/** One shot keeps its own wording; several shots say why none of them fits (the selection bar's reason). */
function groupsFor(shots: readonly StudioShot[]): Group[] {
  return TASKS.map((task) => {
    const fit = shots.filter((shot) => shotFitsTask(shot, task)).length;
    const blocked = fit > 0 ? null : shots.length > 1 ? taskUnfitReason(shots, task) : shotUnfitReason(task);
    return { task, label: groupLabel(task), blocked, fit };
  });
}

/** The route every shot uses (the chosen row); null when they differ, so no row is chosen. */
function sharedRoute(shots: readonly StudioShot[]): string | null {
  const first = shots[0];
  return first !== undefined && shots.every((shot) => shot.route === first.route) ? first.route : null;
}

interface RouteEstimate {
  plan: PlanEta | null;
  /** The tooltip: the estimate with its band, or why there is none. */
  title: string;
}

/** 「約 4:20」, or why there is none (「—」 with the reason as its tooltip; `unfit` when the shots cannot use the route). */
function EtaCell({ estimate, pending, unfit }: { estimate: RouteEstimate | undefined; pending: boolean; unfit: string | null }) {
  const plan = estimate?.plan ?? null;
  const known = unfit === null;
  const title = unfit ?? estimate?.title ?? t("尚無預估");
  return (
    <span className="machine truncate text-right text-caption text-fg-tertiary" title={title}>
      {plan ? t("約 {time}", { time: formatEtaClock(plan.totalSeconds) }) : pending && known ? "…" : "—"}
    </span>
  );
}

function RouteRow({
  route,
  name,
  checked,
  blocked,
  multi,
  describedBy,
  estimate,
  pending,
  onChoose,
  onShowComponents,
  index,
}: {
  route: StudioRoute;
  name: string;
  checked: boolean;
  /** Why the shots cannot use the route (its group's reason); null when they can. */
  blocked: string | null;
  /** Several shots: the time column holds their total, so it is wider. */
  multi: boolean;
  describedBy: string | undefined;
  estimate: RouteEstimate | undefined;
  pending: boolean;
  onChoose: () => void;
  onShowComponents: () => void;
  index: number;
}) {
  const { catalog } = useStudio();
  const face = routeFace(route, catalog);
  return (
    <div ref={reveal(index)} className="flex min-w-0 items-center gap-1">
      <label
        title={route.ready ? face.title : `${face.title}\n${route.summary}`}
        className={cn(
          OPTION_CARD,
          "grid min-h-11 min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
          multi ? "grid-cols-[0.875rem_minmax(0,1fr)_auto_4rem_4rem_4.5rem]" : "grid-cols-[0.875rem_minmax(0,1fr)_auto_4rem_4rem_3.5rem]",
          checked ? OPTION_SELECTED : blocked !== null ? "cursor-not-allowed border-line-subtle bg-canvas/30" : cn("cursor-pointer", OPTION_IDLE),
        )}
      >
        <input type="radio" name={name} checked={checked} disabled={blocked !== null && !checked} onChange={onChoose} aria-describedby={describedBy} className="sr-only" />
        <span aria-hidden className={cn("grid size-3.5 place-items-center rounded-full border transition-colors duration-(--duration-fast)", checked ? "border-brand-cyan" : "border-line-control")}>
          {checked ? <span className="size-1.5 rounded-full bg-brand-cyan animate-pop-in" /> : null}
        </span>
        <span className="grid min-w-0">
          <span className={cn("min-w-0 text-data leading-snug [overflow-wrap:anywhere]", blocked !== null && !checked ? "text-fg-tertiary" : "text-fg")}>{face.name}</span>
          <RouteCaveatLine route={route} />
        </span>
        <CapabilityBadge task={route.capability} />
        <span className="truncate text-caption text-fg-secondary">{face.machine ?? "—"}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-caption">
          <ReadyDot ready={route.ready} />
          <span className={cn("truncate", route.ready ? "text-success" : "text-warning")}>{route.ready ? t("就緒") : t("未就緒")}</span>
        </span>
        <EtaCell estimate={estimate} pending={pending} unfit={blocked === null ? null : multi ? blocked : t("這條路線不能用在這個鏡頭目前的方式")} />
      </label>
      <Button size="icon-sm" variant="quiet" icon={<Cpu aria-hidden />} aria-label={t("查看「{name}」的元件", { name: face.name })} title={t("查看「{name}」的元件", { name: face.name })} onClick={onShowComponents} />
    </div>
  );
}

export interface RouteListProps {
  /** The current shot. */
  shot: StudioShot;
  /** The shot list's multi-selection (two or more shots, list order); null without one: the tab acts on `shot`. */
  selection: readonly StudioShot[] | null;
  onShowComponents: (routeId: string) => void;
}

export function RouteList({ shot, selection, onShowComponents }: RouteListProps) {
  const { project, engine, dispatch } = useStudio();
  const edit = useShotsEdit();
  const id = useId();
  const shots = selection ?? [shot];
  const multi = shots.length > 1;
  const groups = groupsFor(shots)
    .map((group) => ({ ...group, routes: engine.routes.filter((route) => route.capability === group.task) }))
    .filter((group) => group.routes.length > 0);
  // The time on every route the shots can use, rendered together there (one request for all of them); a route where
  // one of them cannot be estimated (unknown reference media) has no estimate rather than a partial one
  const asked = engine.routes.flatMap((route): { routeId: string; inputs: SegmentEtaInput[] }[] => {
    const fitting = shots.filter((item) => shotFitsTask(item, route.capability)).map((item) => ({ ...item, route: route.id }));
    const inputs = shotsEtaInputs(project, fitting, engine.routes);
    return inputs.length > 0 && inputs.every((input): input is SegmentEtaInput => input !== null) ? [{ routeId: route.id, inputs }] : [];
  });
  const { pending, results } = useSegmentEstimates(asked.flatMap((item) => item.inputs));
  const estimates = new Map<string, RouteEstimate>();
  let at = 0;
  for (const item of asked) {
    const own = results?.slice(at, at + item.inputs.length);
    at += item.inputs.length;
    if (!own) continue;
    const plan = planEta(own);
    // One shot: the segment's own wording (as before); several: the plan's, with the records behind it
    estimates.set(item.routeId, { plan, title: multi ? (plan ? planEtaText(plan) : t("尚無預估")) : segmentEtaText(own[0]) });
  }
  const checkedRoute = sharedRoute(shots);
  const missing = engine.status === "ready" ? shots.filter((item) => !findRoute(engine.routes, item.route)) : [];
  const choose = (route: StudioRoute) => (multi ? edit.setRoute(shots, route) : dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { route: route.id } }));
  // Stagger order of the rows across the groups
  const order = new Map(groups.flatMap((group) => group.routes).map((route, index) => [route.id, index]));
  const titles = (list: readonly StudioShot[]) => formatList(list.map((item) => item.title || t("未命名鏡頭")));
  return (
    <div role="radiogroup" aria-label={multi ? t("選取的鏡頭的路線") : t("這個鏡頭的路線")} className="grid gap-3">
      {multi ? (
        <p title={titles(shots)} className={cn("flex items-center gap-1.5 rounded-md border border-brand-blue/40 bg-brand-gradient-soft px-2.5 py-1.5 text-caption text-fg", RISE_IN)}>
          <ListChecks aria-hidden className="size-3.5 shrink-0 text-brand-cyan" />
          {t("套用到選取的 {count} 個鏡頭", { count: shots.length })}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p role="alert" className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-caption text-warning" title={multi ? titles(missing) : shot.route}>
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {multi
            ? t("選取的鏡頭中有 {count} 個的路線已不存在：選一條路線，或在生成列重新選方式。", { count: missing.length })
            : t("這個鏡頭的路線已不存在：選一條路線，或在生成列重新選方式。")}
        </p>
      ) : null}
      {groups.map((group) => {
        const captionId = `${id}-${group.task}`;
        // Several shots, of which this group's routes take only some: say how many a choice changes
        const caption = group.blocked ?? (group.fit < shots.length ? t("只會改其中 {count} 個鏡頭：其他鏡頭的方式不能用這些路線", { count: group.fit }) : null);
        return (
          <section key={group.task} aria-labelledby={`${captionId}-title`} className="grid gap-1.5">
            <div className="grid gap-0.5 px-0.5">
              <h3 id={`${captionId}-title`} className="text-caption font-semibold text-fg-secondary">
                {group.label}
              </h3>
              {caption ? (
                <p id={captionId} className="text-caption text-fg-tertiary">
                  {caption}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1">
              {group.routes.map((route) => (
                <RouteRow
                  key={route.id}
                  index={order.get(route.id) ?? 0}
                  route={route}
                  name={`${id}-route`}
                  checked={route.id === checkedRoute}
                  blocked={group.blocked}
                  multi={multi}
                  describedBy={caption ? captionId : undefined}
                  estimate={estimates.get(route.id)}
                  pending={pending}
                  onChoose={() => choose(route)}
                  onShowComponents={() => onShowComponents(route.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
