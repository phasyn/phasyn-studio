// Components that load when a render uses them (load_policy on_demand): the route is ready to render, and the screens
// say 「使用時載入（約 N 秒）」 instead of 未就緒. The seconds are the components' fitted load time (GET /api/cost-profiles
// load_ms, summed when several load); none when any of them has no load record. An older Controller without load_policy
// reports no such component, so nothing changes there.
import { useQueries } from "@tanstack/react-query";
import { costProfilesQueryOptions } from "@/api/costProfiles";
import { t } from "@/i18n";
import { onUseSlots, type StudioRoute } from "../../model/routes";

export interface OnUseLoad {
  /** The route has components that load on use. */
  onUse: boolean;
  /** Their estimated load time together; null when unknown. */
  seconds: number | null;
}

/** The on-use load of each route, keyed by route id (one profile query per Node, cached and never polled). */
export function useOnUseLoads(routes: readonly (StudioRoute | null)[]): ReadonlyMap<string, OnUseLoad> {
  const slots = routes.flatMap((route) => (route ? onUseSlots(route).map((slot) => ({ route: route.id, slot })) : []));
  const nodes = [...new Set(slots.map(({ slot }) => slot.nodeId))].sort();
  const lists = useQueries({ queries: nodes.map((nodeId) => costProfilesQueryOptions({ node_id: nodeId })) });
  const loadMs = new Map<string, number>();
  for (const list of lists) {
    for (const profile of list.data?.items ?? []) {
      if (profile.load_ms !== null && profile.load_ms >= 0) loadMs.set(`${profile.node_id}:${profile.component_id}`, Math.max(loadMs.get(`${profile.node_id}:${profile.component_id}`) ?? 0, profile.load_ms));
    }
  }
  const out = new Map<string, OnUseLoad>();
  for (const route of routes) {
    if (!route) continue;
    const own = onUseSlots(route);
    if (own.length === 0) continue;
    const known = own.map((slot) => loadMs.get(`${slot.nodeId}:${slot.componentId}`));
    const seconds = known.every((value): value is number => value !== undefined) ? Math.max(1, Math.round(known.reduce((sum, value) => sum + value, 0) / 1000)) : null;
    out.set(route.id, { onUse: true, seconds });
  }
  return out;
}

export function useOnUseLoad(route: StudioRoute | null): OnUseLoad | null {
  return useOnUseLoads([route]).get(route?.id ?? "") ?? null;
}

/** 「使用時載入（約 N 秒）」, or without the seconds when no load has been recorded. */
export function onUseText(load: OnUseLoad): string {
  return load.seconds === null ? t("使用時載入") : t("使用時載入（約 {seconds} 秒）", { seconds: load.seconds });
}
