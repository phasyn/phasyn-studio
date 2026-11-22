// The engine sheet's 路線 tab: every route (saved component combination) in a compact list, grouped by what it does —
// 參考生成, 首幀, 文字, 延展, 重繪, 控制, 表演驅動, 音訊驅動 (model/providerTraits.ts derives the purpose from the
// components' facts and wiring) — and a 實驗 group, collapsed unless the shot uses one of its routes, for the research and
// experiment variants. Each row: name, the machine its main generation step runs on, state, and this shot's estimated
// render time on it. The shot's route is the chosen row; choosing another row pins that route for the shot. Routes the
// shot's 方式 cannot use (a first frame on a route without one, or the edit tools' 延展／重繪／控制 routes) are listed but
// cannot be chosen; their components can still be shown. Names are the part before the first 「：」 outside brackets of a
// label, shown whole (they wrap instead of being cut); the full label is the row's tooltip.
// While the shot list has a multi-selection the tab acts on the selected shots instead, as the selection bar's 路線
// does (hooks/useShotsEdit.ts): a note says so, the chosen row is the route they all share (none when they differ),
// choosing a row moves every selected shot whose first frame fits it in one document edit, a route none of them can
// use cannot be chosen and one only some of them can use says how many it changes, and the time is theirs together.
// Rows are at least 44 px; a route with a caveat (a DiT of fewer than 4 steps) shows it under its name inside the same row.
// Native radios (arrow keys move and choose, like the old route cards).
import { ChevronRight, Cpu, ListChecks, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED, RISE_IN } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { useSegmentEstimates } from "../../hooks/usePlanEta";
import { routeUnfitReason, useShotsEdit } from "../../hooks/useShotsEdit";
import { formatEtaClock, planEta, planEtaText, segmentEtaText, shotsEtaInputs, type PlanEta, type SegmentEtaInput } from "../../model/eta";
import { shotFitsRoute } from "../../model/generationMode";
import { PURPOSE_ORDER, SHOT_PURPOSES, type RoutePurpose } from "../../model/providerTraits";
import { findRoute, type StudioRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { PurposeBadge, ReadyDot, RouteCaveatLine } from "../routeParts";
import { onUseText, useOnUseLoads, type OnUseLoad } from "./loadOnUse";
import { EXPERIMENT_ICON, PURPOSE_ICON, PURPOSE_LABEL, routeFace } from "./modeText";

type GroupKey = RoutePurpose | "experimental";

interface Group {
  key: GroupKey;
  label: string;
  routes: StudioRoute[];
}

/** Why one shot cannot use this route (its first-frame setting needs the other kind, or the route is an edit tool's); null when it can. */
function shotUnfitReason(shot: StudioShot, route: StudioRoute): string | null {
  if (shotFitsRoute(shot, route)) return null;
  if (!SHOT_PURPOSES.has(route.purpose)) return t("這類路線用在剪輯工作區的延展、重繪與控制工具，不從鏡頭直接渲染");
  return route.purpose === "first-frame"
    ? t("這些路線需要首幀：要用它們，先在生成列把方式改成「接續上一鏡」或「首幀圖片」")
    : t("這個鏡頭用首幀：要用這些路線，先在生成列把方式改成首幀以外的方式");
}

/** Why none of the shots can use the route; null when one of them can (one shot keeps its own wording). */
function routeBlocked(shots: readonly StudioShot[], route: StudioRoute): string | null {
  const first = shots[0];
  if (shots.length === 1 && first) return shotUnfitReason(first, route);
  return routeUnfitReason(shots, route);
}

/** The routes by purpose (in PURPOSE_ORDER), then the experimental group; empty groups are left out. */
function groupRoutes(routes: readonly StudioRoute[]): Group[] {
  const groups: Group[] = PURPOSE_ORDER.map((purpose) => ({ key: purpose, label: PURPOSE_LABEL[purpose], routes: routes.filter((route) => !route.experimental && route.purpose === purpose) }));
  groups.push({ key: "experimental", label: t("實驗"), routes: routes.filter((route) => route.experimental) });
  return groups.filter((group) => group.routes.length > 0);
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
    <span className="machine truncate text-right text-caption text-fg-tertiary @max-md/routes:hidden" title={title}>
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
  showPurpose,
  load,
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
  /** The experimental group mixes purposes: each row names its own. */
  showPurpose: boolean;
  /** Components that load when the render uses them (the route is ready; the state says 使用時載入). */
  load: OnUseLoad | undefined;
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
          multi ? "grid-cols-[0.875rem_minmax(0,1fr)_auto_5rem_5.5rem_4.5rem]" : "grid-cols-[0.875rem_minmax(0,1fr)_auto_5rem_5.5rem_3.5rem]",
          // A narrow sheet (a small window) keeps the name, the state and the badge; the machine and the time move to the tooltip
          "@max-md/routes:grid-cols-[0.875rem_minmax(0,1fr)_auto_5.5rem]",
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
        {showPurpose ? <PurposeBadge purpose={route.purpose} /> : <span aria-hidden />}
        <span className="truncate text-caption text-fg-secondary @max-md/routes:hidden">{face.machine ?? "—"}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-caption" title={route.ready && load ? onUseText(load) : undefined}>
          <ReadyDot ready={route.ready} />
          {route.placement !== null ? (
            <span className="truncate text-warning" title={route.placement}>{t("這台不能執行")}</span>
          ) : route.ready && load ? (
            <span className="truncate text-info">{t("使用時載入")}</span>
          ) : (
            <span className={cn("truncate", route.ready ? "text-success" : "text-warning")}>{route.ready ? t("就緒") : t("未就緒")}</span>
          )}
        </span>
        <EtaCell estimate={estimate} pending={pending} unfit={blocked} />
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
  const groups = groupRoutes(engine.routes);
  const loads = useOnUseLoads(engine.routes);
  const checkedRoute = sharedRoute(shots);
  // The 實驗 group opens by itself when the shots use one of its routes
  const [experimentsOpen, setExperimentsOpen] = useState(() => engine.routes.some((route) => route.experimental && route.id === checkedRoute));
  // The time on every route the shots can use, rendered together there (one request for all of them); a route where
  // one of them cannot be estimated (unknown reference media, a route that is not H3) has no estimate rather than a partial one
  const asked = engine.routes.flatMap((route): { routeId: string; inputs: SegmentEtaInput[] }[] => {
    const fitting = shots.filter((item) => shotFitsRoute(item, route)).map((item) => ({ ...item, route: route.id }));
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
  const missing = engine.status === "ready" ? shots.filter((item) => !findRoute(engine.routes, item.route)) : [];
  const choose = (route: StudioRoute) => { if (multi) { edit.setRoute(shots, route); } else { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { route: route.id } }); } };
  // Stagger order of the rows across the groups
  const order = new Map(groups.flatMap((group) => group.routes).map((route, index) => [route.id, index]));
  const titles = (list: readonly StudioShot[]) => formatList(list.map((item) => item.title || t("未命名鏡頭")));
  // The shot's own route is in view when the tab opens (it may sit in a group far down the list)
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("input[type=radio]:checked")?.closest("label")?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div ref={listRef} role="radiogroup" aria-label={multi ? t("選取的鏡頭的路線") : t("這個鏡頭的路線")} className="@container/routes grid gap-3">
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
        const captionId = `${id}-${group.key}`;
        const experimental = group.key === "experimental";
        const Icon = group.key === "experimental" ? EXPERIMENT_ICON : PURPOSE_ICON[group.key];
        const blocked = new Map(group.routes.map((route) => [route.id, route.placement ?? routeBlocked(shots, route)]));
        const reasons = [...new Set(blocked.values())];
        const shared = reasons.length === 1 ? (reasons[0] ?? null) : null;
        // Several shots, of which this group's routes take only some: say how many a choice changes
        const lead = group.routes[0];
        const fit = lead ? shots.filter((item) => shotFitsRoute(item, lead)).length : 0;
        const caption = shared ?? (!experimental && multi && fit > 0 && fit < shots.length ? t("只會改其中 {count} 個鏡頭：其他鏡頭的方式不能用這些路線", { count: fit }) : null);
        const open = !experimental || experimentsOpen;
        return (
          <section key={group.key} aria-labelledby={`${captionId}-title`} className="grid gap-1.5">
            <div className="grid gap-0.5 px-0.5">
              <h3 id={`${captionId}-title`} className="text-caption font-semibold text-fg-secondary">
                {experimental ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`${captionId}-rows`}
                    onClick={() => { setExperimentsOpen((value) => !value); }}
                    className="-mx-1 inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 transition-colors duration-(--duration-fast) hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <ChevronRight aria-hidden className={cn("size-3.5 transition-transform duration-(--duration-fast) motion-reduce:transition-none", open && "rotate-90")} />
                    <Icon aria-hidden className="size-3.5" />
                    {group.label}
                    <span className="font-normal text-fg-tertiary">{t("{count} 條", { count: group.routes.length })}</span>
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon aria-hidden className="size-3.5" />
                    {group.label}
                  </span>
                )}
              </h3>
              {open && (caption != null && caption !== "") ? (
                <p id={captionId} className="text-caption text-fg-tertiary">
                  {caption}
                </p>
              ) : null}
            </div>
            {open ? (
              <div id={`${captionId}-rows`} className="grid gap-1 animate-fade-in">
                {group.routes.map((route) => (
                  <RouteRow
                    key={route.id}
                    index={order.get(route.id) ?? 0}
                    route={route}
                    name={`${id}-route`}
                    checked={route.id === checkedRoute}
                    blocked={blocked.get(route.id) ?? null}
                    multi={multi}
                    describedBy={(caption != null && caption !== "") ? captionId : undefined}
                    estimate={estimates.get(route.id)}
                    pending={pending}
                    showPurpose={experimental}
                    load={loads.get(route.id)}
                    onChoose={() => { choose(route); }}
                    onShowComponents={() => { onShowComponents(route.id); }}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
