// How H3 preprocesses a reference image (the H3 adapter's resolve_reference_image_shape): the short edge is scaled to
// 2048 (or the route's TE reference_image_short_edge) and each side snapped to the nearest multiple of 32; aspect
// ratios outside 1:4–4:1 are rejected. Pure functions.
import { t } from "@/i18n";

export const REFERENCE_SHORT_EDGE = 2048;
export const REFERENCE_MULTIPLE = 32;
export const REFERENCE_MAX_RATIO = 4;

/** Python round() (ties to even), the same rounding the adapter uses for _nearest_multiple. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function nearestMultiple(value: number, multiple: number): number {
  return Math.max(multiple, roundHalfEven(value / multiple) * multiple);
}

/** Why H3 would reject the image (ratio beyond 1:4／4:1); null when usable or when the size is unknown (no guessing). */
export function referenceRatioProblem(width: number | null, height: number | null): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  if (width > REFERENCE_MAX_RATIO * height || height > REFERENCE_MAX_RATIO * width) return t("圖片 {width}×{height} 的比例超過 1:4／4:1，H3 會拒絕這張參考圖", { width, height });
  return null;
}

/** Size after H3 preprocessing to `shortEdge`; null when the size is unknown or the ratio is rejected. */
export function preparedReferenceSize(width: number | null, height: number | null, shortEdge = REFERENCE_SHORT_EDGE): { width: number; height: number } | null {
  if (width === null || height === null || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (referenceRatioProblem(width, height)) return null;
  const scale = shortEdge / Math.min(width, height);
  return { width: nearestMultiple(width * scale, REFERENCE_MULTIPLE), height: nearestMultiple(height * scale, REFERENCE_MULTIPLE) };
}

/** Total preprocessed area (px²) of a set of reference images at `shortEdge`; null when any size is unknown. */
export function preparedArea(images: readonly { width: number | null; height: number | null }[], shortEdge = REFERENCE_SHORT_EDGE): number | null {
  let total = 0;
  for (const image of images) {
    const size = preparedReferenceSize(image.width, image.height, shortEdge);
    if (!size) return null;
    total += size.width * size.height;
  }
  return total;
}
