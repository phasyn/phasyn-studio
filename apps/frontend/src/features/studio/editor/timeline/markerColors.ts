// The fill of a marker by its colour name (ruler, Markers panel).
import type { TimelineMarker } from "@/api/generated/contracts";

export const MARKER_COLOR: Record<TimelineMarker["color"], string> = {
  blue: "bg-brand-blue",
  green: "bg-success",
  amber: "bg-warning",
  rose: "bg-danger",
  violet: "bg-brand-violet",
};
