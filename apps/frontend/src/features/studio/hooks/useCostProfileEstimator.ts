// The Studio's data-driven render-time estimator: the cost profiles of the components the given routes use (GET
// /api/cost-profiles, one query per Node — a Node's list covers all its components — never polled) with each route's
// own facts from the catalog (component state, device, and the `facts.cost_model` constants). Provide the result
// through SegmentEtaContext.
// The estimator id changes whenever a profile list is read again or a route's components change, so usePlanEta asks
// again; invalidating the ["cost-profiles"] prefix after a run succeeds brings in its recordings.
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { costProfilesQueryOptions } from "@/api/costProfiles";
import type { CostProfile } from "@/api/generated/contracts";
import { etaRoute, NO_ETA, profileEstimator, type SegmentEtaEstimator } from "../model/eta";
import type { StudioRoute } from "../model/routes";

/** Every Node the routes' steps run on, once each, in a stable order. */
function nodesOf(routes: readonly StudioRoute[]): string[] {
  return [...new Set(routes.flatMap((route) => route.steps.map(({ step }) => step.node_id)))].sort();
}

/** The components (Node + component id) the routes' steps use. */
function componentKeys(routes: readonly StudioRoute[]): Set<string> {
  return new Set(routes.flatMap((route) => route.steps.map(({ step }) => `${step.node_id}\u0000${step.component_id}`)));
}

/** What an estimate depends on besides the profiles: each step's component, state, device and cost_model facts. */
function routeSignature(routes: readonly StudioRoute[]): string {
  return JSON.stringify(
    routes.map((route) => [
      route.id,
      route.steps.map(({ step, slot }) => [step.step_id, step.node_id, step.component_id, slot.component?.state ?? null, slot.component?.device.id ?? null, slot.component?.facts ?? null]),
    ]),
  );
}

/** FNV-1a (32-bit) as 8 hex digits: a short, stable part of a cache key. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const profileQuery = (nodeId: string) => costProfilesQueryOptions({ node_id: nodeId });

/** An estimator over these routes' cost profiles; NO_ETA when there is no route. */
export function useCostProfileEstimator(routes: readonly StudioRoute[]): SegmentEtaEstimator {
  const client = useQueryClient();
  const nodes = useMemo(() => nodesOf(routes), [routes]);
  const lists = useQueries({ queries: nodes.map(profileQuery) });
  const version = lists.map((query) => query.dataUpdatedAt).join(".");
  const signature = useMemo(() => fingerprint(routeSignature(routes)), [routes]);
  return useMemo(() => {
    if (nodes.length === 0) return NO_ETA;
    const id = `cost-profiles:${signature}:${fingerprint(version)}`;
    const etaRoutes = Object.fromEntries(routes.map((route) => [route.id, etaRoute(route)]));
    return {
      id,
      estimate: async (segments, signal) => {
        const used = routes.filter((route) => segments.some((segment) => segment.routeId === route.id));
        const wanted = componentKeys(used);
        // Fresh lists come from the cache; a Node whose profiles cannot be read only leaves its steps unknown
        const read = await Promise.all(nodesOf(used).map((nodeId) => client.query(profileQuery(nodeId)).then((list) => list.items, (): CostProfile[] => [])));
        const profiles = read.flat().filter((profile) => wanted.has(`${profile.node_id}\u0000${profile.component_id}`));
        return profileEstimator(id, profiles, etaRoutes).estimate(segments, signal);
      },
    };
  }, [client, nodes, routes, signature, version]);
}
