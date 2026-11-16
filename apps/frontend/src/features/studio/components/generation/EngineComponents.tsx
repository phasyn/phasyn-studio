// The engine sheet's 元件 tab: the components of a route — the selected shot's (the project default without a shot), or
// another route's when the 路線 tab or a 方式 asked for it. One line on top says 全部就緒, or how many components are
// missing with the start action for the stopped ones; below it the route's name, task and machine with its wiring, one
// row per pipeline step (plus, for a first-frame route, the frame extractor continuing needs), the members of the DiT's
// exclusive group already loaded on its machine (what starting will do), and the sequence-export component only when it
// cannot be used. Starting and stopping go through the shell's engine control: one request each, the same device in
// order, exclusive groups and resident components confirmed by the person, nothing resent.
import { CircleCheck, Info, Power, TriangleAlert } from "lucide-react";
import { indexCatalog } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { providerKind } from "@/components/workbench/kinds";
import { exclusiveBlockReason, exclusiveConflict, exclusiveReplaceNote } from "@/features/components";
import type { EngineControl } from "@/features/studio-shell";
import { placeLabel } from "@/lib/deviceTag";
import { unusableSlots } from "../../model/generationMode";
import { findRoute, routeContinuity, type ComponentSlot, type StudioRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { CapabilityBadge, ReadyDot, RouteCaveatLine, RouteReadiness, RoutesUnavailable } from "../routeParts";
import { EngineComponentRow } from "./EngineComponentRow";
import { routeFace } from "./modeText";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const FALLBACK_KIND = providerKind(null);
const startable = (component: ComponentDescriptor | null): component is ComponentDescriptor => component !== null && (component.state === "stopped" || component.state === "error");
const keyOf = (component: Pick<ComponentDescriptor, "node_id" | "component_id">) => `${component.node_id}:${component.component_id}`;

function SlotRow({ slot, title, stepId, control }: { slot: ComponentSlot; title?: string; stepId?: string; control: EngineControl }) {
  const { catalog } = useStudio();
  const component = slot.component;
  const kind = providerKind(component?.provider_id);
  return (
    <EngineComponentRow
      component={component}
      title={title ?? (kind !== FALLBACK_KIND ? kind.label : (stepId ?? slot.componentId))}
      tag={stepId}
      detail={component ? <T source={"<0>{component_id}</0>・{nodeLabel}"} values={{ component_id: component.component_id, nodeLabel: slot.nodeLabel }} slots={[<code className="machine" />]} /> : slot.reason}
      detailTitle={slot.reason ?? undefined}
      phase={component ? control.phaseOf(component) : undefined}
      blockStart={component ? exclusiveBlockReason(exclusiveConflict(component, catalog)) : null}
      onStart={(target) => control.start([target])}
      onStop={control.stop}
    />
  );
}

/** Members of the DiT's exclusive group already loaded on its Node: what starting will do, or why it cannot start now. */
function ExclusiveHolders({ route, control }: { route: StudioRoute; control: EngineControl }) {
  const { catalog } = useStudio();
  const dit = route.steps.find((item) => item.step.step_id === route.ditStepId)?.slot.component ?? null;
  const conflict = dit ? exclusiveConflict(dit, catalog) : null;
  if (!dit || !conflict) return null;
  const index = indexCatalog(catalog);
  const holders = conflict.holders.flatMap((holder) => index.component(dit.node_id, holder.component_id) ?? []);
  return (
    <div className="grid gap-1.5">
      <p className="flex items-start gap-1.5 text-caption text-warning [overflow-wrap:anywhere]">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {exclusiveBlockReason(conflict) ?? exclusiveReplaceNote(conflict)}
      </p>
      <ul aria-label={t("同一台 Node 上同一個互斥群組已載入的元件")} className="grid gap-1.5">
        {holders.map((component) => (
          <EngineComponentRow
            key={keyOf(component)}
            component={component}
            title={t("{label}・{value}", { label: providerKind(component.provider_id).label, value: component.label || component.component_id })}
            detail={t("{component_id}・{placeLabel}", { component_id: component.component_id, placeLabel: placeLabel(component.device, index.nodeLabel(component.node_id) ?? component.node_id.slice(0, 8)) })}
            phase={control.phaseOf(component)}
            onStart={(target) => control.start([target])}
            onStop={control.stop}
          />
        ))}
      </ul>
    </div>
  );
}

/** 全部就緒, or 缺 n 個元件 with the start action for the stopped ones (one request each, in order). */
function Summary({ route, frame, control }: { route: StudioRoute; frame: ComponentSlot | null; control: EngineControl }) {
  const slots = [...route.steps.map((item) => item.slot), ...(frame ? [frame] : [])];
  const missing = unusableSlots(route, frame ? [frame] : []).length;
  const stopped = [...new Map(slots.flatMap((slot) => (startable(slot.component) ? [[keyOf(slot.component), slot.component] as const] : []))).values()];
  const starting = slots.some(({ component }) => {
    const phase = component ? control.phaseOf(component) : undefined;
    return phase === "queued" || phase === "starting";
  });
  if (missing === 0 && route.ready) {
    return (
      <p className="flex h-9 items-center gap-1.5 text-data font-medium text-success animate-fade-in">
        <CircleCheck aria-hidden className="size-4" />
        {t("全部就緒")}
      </p>
    );
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
      <p className="flex items-center gap-1.5 text-data font-medium text-warning" title={route.problems.join("\n") || undefined}>
        <TriangleAlert aria-hidden className="size-4" />
        {missing > 0 ? t("缺 {count} 個元件", { count: missing }) : t("路線有問題，渲染會被擋下")}
      </p>
      {stopped.length > 0 || starting ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<Power aria-hidden />}
          pending={starting}
          onClick={() => control.start(stopped)}
          title={starting ? t("正在依序啟動這個元件組合需要的元件（各列顯示目前進度）") : t("只啟動這個元件組合中已停止或錯誤的 {stoppedCount} 個元件；同一張卡依序載入", { stoppedCount: stopped.length })}
        >
          {starting ? t("正在啟動需要的元件…") : t("啟動 {count} 個", { count: stopped.length })}
        </Button>
      ) : (
        <RouteReadiness route={route} />
      )}
    </div>
  );
}

function RouteComponents({ route, control }: { route: StudioRoute; control: EngineControl }) {
  const { catalog } = useStudio();
  const face = routeFace(route, catalog);
  const frame = route.capability === "fl2va" ? routeContinuity(route, catalog).frame : null;
  const stepReasons = new Set(route.steps.flatMap((item) => (item.slot.reason ? [item.slot.reason] : [])));
  const otherProblems = route.problems.filter((problem) => !stepReasons.has(problem));
  return (
    <section aria-labelledby={`engine-route-${route.id}`} className="grid gap-2.5">
      <Summary route={route} frame={frame} control={control} />
      <div className="grid gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <ReadyDot ready={route.ready} />
          <h3 id={`engine-route-${route.id}`} className="min-w-0 text-data font-semibold text-fg [overflow-wrap:anywhere]" title={`${route.label}\n${route.id}`}>
            {face.name}
          </h3>
          <CapabilityBadge task={route.capability} />
          {face.machine ? <span className="shrink-0 text-caption text-fg-tertiary">{face.machine}</span> : null}
        </div>
        <RouteCaveatLine route={route} className="pl-4" />
        {face.wiring ? <p className="pl-4 text-caption text-fg-tertiary [overflow-wrap:anywhere]">{face.wiring}</p> : null}
      </div>
      <ul aria-label={t("「{label}」的步驟元件", { label: face.name })} className="grid gap-1.5">
        {route.steps.map((item) => (
          <SlotRow key={item.step.step_id} slot={item.slot} stepId={item.step.step_id} control={control} />
        ))}
      </ul>
      <ExclusiveHolders route={route} control={control} />
      {frame ? (
        <div className="grid gap-1.5">
          <p className="text-caption text-fg-tertiary">{t("接續上一鏡另外需要（不在元件組合內，渲染時由 Studio 加入；首幀圖片不需要）：")}</p>
          <ul className="grid gap-1.5">
            <SlotRow slot={frame} title={t("取出影格（首幀）")} control={control} />
          </ul>
        </div>
      ) : null}
      {route.notes.length > 0 ? (
        <ul className="grid gap-1 text-caption text-fg-secondary">
          {route.notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />
              {note}
            </li>
          ))}
        </ul>
      ) : null}
      {otherProblems.length > 0 ? (
        <ul className="grid gap-1 text-caption text-warning">
          {otherProblems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {problem}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function EngineComponents({
  shotRoute,
  shotRouteId,
  viewedRouteId,
  control,
  onBackToShot,
}: {
  /** The selected shot's route (the project default without a shot); null when it does not exist. */
  shotRoute: StudioRoute | null;
  shotRouteId: string;
  /** Another route to show instead; null = the shot's. */
  viewedRouteId: string | null;
  control: EngineControl;
  onBackToShot: () => void;
}) {
  const { engine, catalog, setEngineOpen } = useStudio();
  const viewed = viewedRouteId ? findRoute(engine.routes, viewedRouteId) : shotRoute;
  const other = viewed !== null && viewedRouteId !== null && viewed.id !== shotRoute?.id;
  return (
    <>
      {engine.status === "error" ? (
        <EmptyState size="compact" illustration="offline" title={t("讀不到元件組合或元件目錄")} description={engine.error ?? t("主控沒有回應；檢查連線後按「重新讀取」。")} />
      ) : (
        <RoutesUnavailable engine={engine} onNavigate={() => setEngineOpen(false)} />
      )}
      {other && viewed ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-caption text-info animate-reveal">
          <Info aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {shotRoute
              ? t("正在查看「{name}」的元件；這個鏡頭用的是「{current}」。", { name: routeFace(viewed, catalog).name, current: routeFace(shotRoute, catalog).name })
              : t("正在查看「{name}」的元件。", { name: routeFace(viewed, catalog).name })}
          </span>
          <Button size="sm" variant="quiet" className="min-h-7 px-2" onClick={onBackToShot}>
            {t("回到鏡頭的路線")}
          </Button>
        </div>
      ) : null}
      {viewed ? (
        <RouteComponents key={viewed.id} route={viewed} control={control} />
      ) : engine.status === "ready" && engine.routes.length > 0 ? (
        <p role="alert" className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-caption text-warning [overflow-wrap:anywhere]" title={shotRouteId}>
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t("這條路線已不存在：在「路線」分頁選一條路線。")}
        </p>
      ) : null}
      {/* 序列匯出不屬於鏡頭的路線；只有它不能用時才列出來（匯出失敗的通知會連到這裡）。 */}
      {engine.concat.usable ? null : (
        <section aria-labelledby="engine-concat" className="grid gap-2">
          <h3 id="engine-concat" className="text-data font-semibold text-fg">
            {t("序列匯出需要")}
          </h3>
          <ul>
            <SlotRow slot={engine.concat} control={control} />
          </ul>
        </section>
      )}
    </>
  );
}
