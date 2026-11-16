// The routes the DiT 分流 dialog (LaneDialog.tsx) offers: one card per route with a DiT. A card leads with where the
// DiT runs (the machine and GPU, named the way the engine sheet names them), then the route's name in a quieter line,
// then a speed line: how many recordings of that DiT's time the controller holds — the cost profiles the split weighs
// lanes by (model/lanes.ts), read through the same per-Node queries as the estimator — with the selected shot's
// predicted DiT time, or that the first batch gives the lane one shot to measure it. The full label, the wiring and
// the component ids stay in the card's tooltip. Rows are 70 px (three lines of 20, 18 and 18 px); every line truncates.
import { useQueries } from "@tanstack/react-query";
import { Gauge, LoaderCircle, Timer, TriangleAlert, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { costProfilesQueryOptions } from "@/api/costProfiles";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { deviceTag } from "@/lib/deviceTag";
import { errorText } from "@/lib/errors";
import { useSegmentEstimates } from "../hooks/usePlanEta";
import { formatEta, profileFits, shotEtaInput } from "../model/eta";
import { ditRecords } from "../model/lanes";
import type { StudioRoute } from "../model/routes";
import { useStudio } from "../studioContext";
import { routeFace } from "./generation/modeText";
import { CapabilityBadge, ReadyDot, RouteCaveatLine } from "./routeParts";
import { t } from "@/i18n";

/** What is known of a route's DiT speed. */
type LaneSpeed =
  | { state: "reading" }
  | { state: "unreadable"; reason: string }
  | { state: "measured"; records: number; shotSeconds: number | null }
  | { state: "unmeasured" };

const CARD_ROW = "grid h-[4.375rem] grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 px-3 py-1.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus";

/**
 * Each route's DiT speed: the recordings behind its fitted DiT time (0 = none yet) and, with a shot selected, that
 * shot's predicted DiT seconds on the route for a loaded, warm DiT (what the split weighs).
 */
function useLaneSpeeds(routes: readonly StudioRoute[]): ReadonlyMap<string, LaneSpeed> {
  const { project, selectedShotId } = useStudio();
  const nodes = [...new Set(routes.flatMap((route) => (route.ditNodeId ? [route.ditNodeId] : [])))].sort();
  const lists = useQueries({ queries: nodes.map((nodeId) => costProfilesQueryOptions({ node_id: nodeId })) });
  const shot = project.shots.find((item) => item.shot_id === selectedShotId);
  const asked = shot
    ? routes.flatMap((route) => {
        const input = shotEtaInput(project, { ...shot, route: route.id }, route, true);
        return input ? [{ routeId: route.id, input }] : [];
      })
    : [];
  const { results } = useSegmentEstimates(asked.map((item) => item.input));
  return new Map(
    routes.map((route): [string, LaneSpeed] => {
      const list = route.ditNodeId ? lists[nodes.indexOf(route.ditNodeId)] : undefined;
      if (!list || list.isPending) return [route.id, { state: "reading" }];
      if (list.isError) return [route.id, { state: "unreadable", reason: errorText(list.error) }];
      const records = ditRecords(route, profileFits([list.data]));
      if (records === 0) return [route.id, { state: "unmeasured" }];
      const at = asked.findIndex((item) => item.routeId === route.id);
      const seconds = at >= 0 && route.ditStepId ? results?.[at]?.steps?.[route.ditStepId] : undefined;
      return [route.id, { state: "measured", records, shotSeconds: typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null }];
    }),
  );
}

interface SpeedFace {
  icon: LucideIcon;
  tone: string;
  text: string;
  title?: string;
  busy?: boolean;
}

function speedFace(route: StudioRoute, speed: LaneSpeed): SpeedFace {
  if (!route.ready) return { icon: TriangleAlert, tone: "text-warning", text: t("未就緒，渲染時略過：{summary}", { summary: route.summary }), title: route.problems.join("\n") };
  if (speed.state === "reading") return { icon: LoaderCircle, tone: "text-fg-tertiary", text: t("讀取速度紀錄…"), busy: true };
  if (speed.state === "unreadable") return { icon: TriangleAlert, tone: "text-warning", text: t("讀不到速度紀錄"), title: speed.reason };
  if (speed.state === "unmeasured") {
    return { icon: Timer, tone: "text-info", text: t("還沒有速度紀錄：第一次批次會先分 1 個鏡頭量測"), title: t("主控還沒有這顆 DiT 的耗時紀錄，無法估算它的速度；量到之後，分流就會照實測的速度分配。") };
  }
  const count = speed.records;
  return {
    icon: Gauge,
    tone: "text-fg-secondary",
    text: speed.shotSeconds === null ? t("有 {count} 筆速度紀錄", { count }) : t("有 {count} 筆速度紀錄・選取的鏡頭 DiT 預估{time}", { count, time: formatEta(speed.shotSeconds) }),
    title: t("速度來自主控記下的 {count} 次 DiT 實際耗時；預估以已載入、暖機的 DiT 計算。", { count }),
  };
}

function SpeedLine({ id, route, speed }: { id: string; route: StudioRoute; speed: LaneSpeed }) {
  const face = speedFace(route, speed);
  const fade = useChangeFade<HTMLSpanElement>(face.text);
  const Icon = face.icon;
  return (
    <span id={id} ref={fade} title={face.title} className={cn("flex min-w-0 items-center gap-1.5 text-caption", face.tone)}>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", face.busy && "animate-spin")} />
      <span className="min-w-0 truncate">{face.text}</span>
    </span>
  );
}

function LaneCard({ route, speed, checked, onToggle, index }: { route: StudioRoute; speed: LaneSpeed; checked: boolean; onToggle: (on: boolean) => void; index: number }) {
  const id = useId();
  const { catalog } = useStudio();
  const face = routeFace(route, catalog);
  const dit = route.steps.find((item) => item.step.step_id === route.ditStepId);
  const device = deviceTag(dit?.slot.component?.device);
  const machine = face.machine ?? t("DiT 所在的機器不明");
  const title = [face.title, dit ? t("DiT：{component}（{place}）", { component: dit.step.component_id, place: dit.slot.nodeLabel }) : null].filter(Boolean).join("\n");
  return (
    <label ref={reveal(index)} htmlFor={`${id}-input`} title={title} className={cn(OPTION_CARD, CARD_ROW, "cursor-pointer", checked ? OPTION_SELECTED : OPTION_IDLE)}>
      <input
        id={`${id}-input`}
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
        aria-labelledby={`${id}-machine ${id}-name`}
        aria-describedby={`${id}-speed`}
        className="mt-0.5 size-4 cursor-pointer accent-action outline-none"
      />
      <span className="grid min-w-0">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <ReadyDot ready={route.ready} />
          <span id={`${id}-machine`} className="min-w-0 truncate text-data font-semibold text-fg">
            {device && face.machine ? t("{label}・{value}", { label: machine, value: device }) : machine}
          </span>
          <CapabilityBadge task={route.capability} className="ml-auto" />
        </span>
        <span id={`${id}-name`} className="truncate text-caption text-fg-tertiary" title={face.title}>
          {face.name}
        </span>
        <RouteCaveatLine route={route} />
        <SpeedLine id={`${id}-speed`} route={route} speed={speed} />
      </span>
    </label>
  );
}

/** A chosen route that no longer exists: listed so it can be unticked. */
function GoneCard({ routeId, onToggle, index }: { routeId: string; onToggle: (on: boolean) => void; index: number }) {
  const id = useId();
  return (
    <label ref={reveal(index)} htmlFor={id} title={routeId} className={cn(OPTION_CARD, CARD_ROW, "cursor-pointer", OPTION_SELECTED)}>
      <input id={id} type="checkbox" checked onChange={(event) => onToggle(event.target.checked)} className="mt-0.5 size-4 cursor-pointer accent-action outline-none" />
      <span className="grid min-w-0">
        <code className="machine h-5 truncate text-data text-fg">{routeId}</code>
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-warning">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t("這條元件組合已不存在")}</span>
        </span>
      </span>
    </label>
  );
}

export function LaneChoices({
  listed,
  unknown,
  selected,
  onToggle,
  describedBy,
}: {
  /** Every route with a DiT, in the engine's order. */
  listed: readonly StudioRoute[];
  /** Chosen route ids that are no longer routes. */
  unknown: readonly string[];
  selected: readonly string[];
  onToggle: (routeId: string, on: boolean) => void;
  describedBy: string;
}) {
  const speeds = useLaneSpeeds(listed);
  return (
    <fieldset className="grid gap-1" aria-describedby={describedBy}>
      <legend className="mb-1 text-data font-semibold text-fg-secondary">{t("分流到這些元件組合")}</legend>
      {listed.map((route, index) => (
        <LaneCard
          key={route.id}
          index={index}
          route={route}
          speed={speeds.get(route.id) ?? { state: "reading" }}
          checked={selected.includes(route.id)}
          onToggle={(on) => onToggle(route.id, on)}
        />
      ))}
      {unknown.map((routeId, index) => (
        <GoneCard key={routeId} index={listed.length + index} routeId={routeId} onToggle={(on) => onToggle(routeId, on)} />
      ))}
    </fieldset>
  );
}
