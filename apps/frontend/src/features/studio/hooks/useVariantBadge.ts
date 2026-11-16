// The badge of a variant take (model/variants.ts): what it was rendered with that its shot does not have now, with
// route names as the lists show them. Null without a take, or for a take that is not a variant. The take strip's
// cards and the monitor (its title row and the A／B chips) show it.
import { useMemo } from "react";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { routeDisplayLabel, routeName } from "../model/routes";
import { variantBadge, type VariantBadge } from "../model/variants";
import { useStudio } from "../studioContext";

export function useVariantBadge(shot: StudioShot | null, take: StudioTake | null): VariantBadge | null {
  const { project, engine } = useStudio();
  const library = project.library;
  return useMemo(
    () => (shot && take ? variantBadge(take, shot, library ?? [], (id) => routeName(routeDisplayLabel(engine.routes, id)).name) : null),
    [shot, take, library, engine.routes],
  );
}
