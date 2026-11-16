// Image Studio's engine sheet: the components the selected image's route (pipeline) needs — state, start／stop and
// "start what this route needs" (the same device in order, different devices in parallel). Exclusive groups (the DiT,
// for example) are enforced by the Node: members of the group already loaded on that Node are listed, and starting
// asks before replacing them. Every write is sent once and never retried automatically (the shell's engine control).
import { CircleCheck, Info, Power, TriangleAlert } from "lucide-react";
import { indexCatalog } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { providerKind } from "@/components/workbench/kinds";
import { Button } from "@/components/ui/button";
import { exclusiveBlockReason, exclusiveConflict, exclusiveReplaceNote } from "@/features/components";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { UNASSIGNED_ROUTE } from "@/features/studio";
import { ComponentRow, EngineSheet, useEngineControl, type EngineControl } from "@/features/studio-shell";
import { placeLabel } from "@/lib/deviceTag";
import { useImageStudio } from "../imageStudioContext";
import { findImageRoute, routeFacts, type ImageRoute } from "../model/routes";
import { imageShots } from "../model/shots";
import { ModeBadge, ReadyDot, VariantBadge } from "./marks";
import { RoutesUnavailable } from "./RouteField";
import { t } from "@/i18n";

const keyOf = (component: Pick<ComponentDescriptor, "node_id" | "component_id">) => `${component.node_id}:${component.component_id}`;
const startable = (component: ComponentDescriptor | null): component is ComponentDescriptor => component !== null && (component.state === "stopped" || component.state === "error");

function RouteSection({ route, control }: { route: ImageRoute; control: EngineControl }) {
  const { catalog } = useImageStudio();
  const index = indexCatalog(catalog);
  const stopped = [...new Map(route.steps.flatMap((item) => (startable(item.slot.component) ? [[keyOf(item.slot.component), item.slot.component] as const] : []))).values()];
  const starting = route.steps.some(({ slot }) => {
    const phase = slot.component ? control.phaseOf(slot.component) : undefined;
    return phase === "queued" || phase === "starting";
  });
  // Members of the DiT's exclusive group already loaded on its Node: starting replaces them (after confirmation) or is blocked
  const dit = route.ditComponent;
  const conflict = dit ? exclusiveConflict(dit, catalog) : null;
  const block = exclusiveBlockReason(conflict);
  const holders = dit && conflict ? conflict.holders.flatMap((holder) => index.component(dit.node_id, holder.component_id) ?? []) : [];
  const stepReasons = new Set(route.steps.flatMap((item) => (item.slot.reason ? [item.slot.reason] : [])));
  const otherProblems = route.problems.filter((problem) => !stepReasons.has(problem));
  // 就緒的元件數（同一個元件被多個步驟使用只算一次；沒有對應元件的步驟算未就緒）
  const slots = [...new Map(route.steps.map((item) => [item.slot.component ? keyOf(item.slot.component) : `missing:${item.step.step_id}`, item.slot.component] as const)).values()];
  const readyCount = slots.filter((component) => component?.state === "ready" || component?.state === "busy").length;
  const headingId = `image-engine-${route.id}`;
  return (
    <section aria-labelledby={headingId} className="grid gap-2.5 rounded-xl border border-line-subtle bg-surface p-3 shadow-edge">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ReadyDot ready={route.ready} />
        <h3 id={headingId} className="min-w-0 text-data font-semibold text-fg [overflow-wrap:anywhere]">
          {route.label}
        </h3>
        <ModeBadge mode={route.capability} />
        <VariantBadge variant={route.variant} />
      </div>
      <code className="machine truncate text-[11px] text-fg-tertiary" title={route.id}>
        {t("{id}・{route}", { id: route.id, route: routeFacts(route) })}
      </code>
      <div className="grid gap-1">
        <ProgressTrack
          value={readyCount}
          max={Math.max(1, slots.length)}
          tone={starting ? "running" : route.ready ? "done" : "idle"}
          label={t("這個元件組合需要的元件就緒數")}
          valueText={t("就緒 {readyCount}／{slotsCount}", { readyCount, slotsCount: slots.length })}
          size="sm"
        />
        <span className="machine text-caption text-fg-tertiary">{t("就緒 {readyCount}／{slotsCount}", { readyCount, slotsCount: slots.length })}</span>
      </div>
      <ul aria-label={t("「{label}」的步驟元件", { label: route.label })} className="grid gap-1.5">
        {route.steps.map((item) => {
          const component = item.slot.component;
          return (
            <ComponentRow
              key={item.step.step_id}
              component={component}
              title={providerKind(component?.provider_id).label}
              tag={item.step.step_id}
              detail={component ? t("{component_id}・{nodeLabel}", { component_id: component.component_id, nodeLabel: item.slot.nodeLabel }) : item.slot.reason}
              detailTitle={item.slot.reason ?? undefined}
              phase={component ? control.phaseOf(component) : undefined}
              blockStart={component ? exclusiveBlockReason(exclusiveConflict(component, catalog)) : null}
              onStart={(target) => control.start([target])}
              onStop={control.stop}
            />
          );
        })}
      </ul>
      {conflict ? (
        <div className="grid gap-1.5">
          <p className="flex items-start gap-1.5 text-caption text-warning [overflow-wrap:anywhere]">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {block ?? exclusiveReplaceNote(conflict)}
          </p>
          <ul aria-label={t("同一台 Node 上同一個互斥群組已載入的元件")} className="grid gap-1.5">
            {holders.map((component) => (
              <ComponentRow
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
      <div className="flex flex-wrap items-center gap-2">
        {stopped.length > 0 || starting ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Power aria-hidden />}
            pending={starting}
            onClick={() => control.start(stopped)}
            title={starting ? t("正在依序啟動（各列顯示目前進度）") : t("只啟動這個元件組合中已停止或錯誤的 {stoppedCount} 個元件；同一張卡依序載入", { stoppedCount: stopped.length })}
          >
            {starting ? t("正在啟動需要的元件…") : t("啟動這個元件組合需要的元件")}
          </Button>
        ) : null}
        {route.ready ? (
          <p className="flex items-center gap-1.5 text-caption text-success">
            <CircleCheck aria-hidden className="size-3.5" />
            {t("可以生成")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function ImageEngineSheet() {
  const { project, selectedShotId, engine, notify } = useImageStudio();
  const control = useEngineControl(notify);
  const shot = imageShots(project).find((item) => item.image_shot_id === selectedShotId) ?? null;
  const route = shot ? findImageRoute(engine.routes, shot.route) : null;
  return (
    <EngineSheet
      title={t("生成引擎")}
      description={
        shot
          ? t("圖片「{value}」的運算路由需要的元件。要換運算路由，到「基本」分頁選擇。GPU 元件啟動會把模型載入顯示卡與主記憶體；同一台 Node 上同一個互斥群組（例如 DiT）一次只能載入一個。", { value: shot.title || t("未命名圖片") })
          : t("沒有選取圖片：選一張圖片後，這裡列出它的運算路由需要的元件。GPU 元件啟動會把模型載入顯示卡與主記憶體；同一台 Node 上同一個互斥群組（例如 DiT）一次只能載入一個。")
      }
      loadFailed={engine.status === "error"}
    >
      <RoutesUnavailable engine={engine} />
      {route ? (
        <RouteSection route={route} control={control} />
      ) : shot && engine.status === "ready" && engine.routes.length > 0 ? (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-caption text-warning [overflow-wrap:anywhere]">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{shot.route === UNASSIGNED_ROUTE ? t("還沒有選擇運算路由：到「基本」分頁選擇。") : t("路由不存在（目前的值：{route}）。到「基本」分頁選擇運算路由。", { route: shot.route })}</span>
        </p>
      ) : null}
      {control.dialogs}
    </EngineSheet>
  );
}
