// One-click swap limits of a route: the capacity declared by the route's DiT component (descriptor `limits.swap`,
// optionally per TE reference video short edge), a conservative default while the DiT declares none, or — when the
// user chooses to try — the swap data model's own bounds, untested. Also the checks built on it: how many characters
// may be added, the per-segment frame limit, how many segments fit in one run and the reminders of the generation
// tab. Nothing here guesses whether something fits in GPU memory: a trial finds out, and a finished trial can be
// recorded as the DiT's measured limits (measure.ts).
import type { ComponentDescriptor, StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import { H3_FPS, H3_FRAME_MAX } from "../model/frames";
import type { StudioRoute } from "../model/routes";
import { floorFrames, MAX_SWAP_CHARACTERS, MIN_SEGMENT_FRAMES, OFFICIAL_REFERENCE_VIDEO_SHORT_EDGE, parseSwapLimits, type ByCharacters, type SwapCapacity } from "./limitSpec";
import { preparedArea, REFERENCE_SHORT_EDGE } from "./referenceImage";
import { t } from "@/i18n";

/** Used while the DiT declares no valid limits.swap: one character, the shortest segment. */
export const SWAP_DEFAULT_CAPACITY: SwapCapacity = {
  maxCharacters: 1,
  maxFrames: MIN_SEGMENT_FRAMES,
  maxFramesByCharacters: null,
  referenceAreaByCharacters: null,
  maxOutputPixels: null,
  beyondLimit: "untested",
  note: null,
};

/**
 * A trial past the default, chosen by the user while the DiT has no measured limits: the swap data model's bounds
 * (four characters, the longest H3 segment). Nothing says it fits; a segment that does not fails in its DiT step.
 */
export const SWAP_TRIAL_CAPACITY: SwapCapacity = {
  maxCharacters: MAX_SWAP_CHARACTERS,
  maxFrames: floorFrames(H3_FRAME_MAX),
  maxFramesByCharacters: null,
  referenceAreaByCharacters: null,
  maxOutputPixels: null,
  beyondLimit: "untested",
  note: null,
};

/** TE (h3.conditioning) experimental parameter: short edge of the preprocessed reference video; unset, null or 768 = official path. */
export const REFERENCE_VIDEO_SHORT_EDGE_PARAM = "reference_video_short_edge";
/** TE (h3.conditioning) parameter: short edge reference images are scaled to; unset or null = the official 2048. */
export const REFERENCE_IMAGE_SHORT_EDGE_PARAM = "reference_image_short_edge";

/** Steps one run may hold (contract Pipeline.steps maxItems); a batch copies the route's steps once per segment. */
export const MAX_RUN_STEPS = 256;

export const AREA_WARNING = t("角色圖預處理後的總面積比量測時大（圖比較細長，或運算路由的參考圖短邊比較大），可能超過顯存；建議把圖裁成接近 3:4 或 4:3");
export const NOT_MEASURED_YET = t("更多角色或更長的段落還沒量測；量測後可以在 DiT 元件的 limits.swap 調整上限");
export const BEYOND_FAILS = t("量測時超過這個上限會失敗（例如顯存不足）");
/** Route-independent wizard tip. */
export const COSTUME_LEAK_TIP = t("注意：原角色的服裝可能部分殘留，建議多試幾個 seed 比較");

export function segmentSeconds(frames: number): string {
  return (frames / H3_FPS).toFixed(2);
}

/**
 * Value of a table keyed by number: the nearest key not below `at`; the largest key when `at` is above all of them;
 * undefined without a table. More characters or frames mean a longer sequence, so what fits a larger point also fits
 * a smaller one — rounding up is the conservative direction.
 */
function atOrAbove(table: ByCharacters | null | undefined, at: number): number | undefined {
  if (!table) return undefined;
  const keys = Object.keys(table)
    .map(Number)
    .filter((key) => Number.isFinite(key))
    .sort((a, b) => a - b);
  const key = keys.find((item) => item >= at) ?? keys.at(-1);
  return key === undefined ? undefined : table[key];
}

/** Per-segment frame limit for this character count (never above maxFrames). */
export function maxFramesFor(limit: Pick<SwapCapacity, "maxFrames" | "maxFramesByCharacters">, characterCount: number): number {
  const frames = atOrAbove(limit.maxFramesByCharacters, characterCount);
  return frames === undefined ? limit.maxFrames : Math.min(frames, limit.maxFrames);
}

/** Measured preprocessed reference area (px²) for this character count; null = no area data. */
export function referenceAreaFor(limit: Pick<SwapCapacity, "referenceAreaByCharacters">, characterCount: number): number | null {
  return atOrAbove(limit.referenceAreaByCharacters, characterCount) ?? null;
}

/** 「1–2 角色每段最多 A 幀；3 角色最多 B 幀」: limits from 1 to maxCharacters, equal limits merged (numbers from limits.swap). */
export function framesByCharactersText(limit: Pick<SwapCapacity, "maxCharacters" | "maxFrames" | "maxFramesByCharacters">): string {
  const groups: { from: number; to: number; frames: number }[] = [];
  for (let count = 1; count <= limit.maxCharacters; count += 1) {
    const frames = maxFramesFor(limit, count);
    const last = groups.at(-1);
    if (last && last.frames === frames) last.to = count;
    else groups.push({ from: count, to: count, frames });
  }
  return groups.map((group, index) => t("{value} 角色{value2}最多 {frames} 影格", { value: group.from === group.to ? group.from : `${group.from}–${group.to}`, value2: index === 0 ? t("每段") : "", frames: group.frames })).join(t("；"));
}

/** The route's DiT (the pipeline's h3.dit step); null without a DiT step. */
export function routeDit(route: StudioRoute | null): { id: string; label: string; component: ComponentDescriptor | null } | null {
  const step = route?.steps.find((item) => item.step.step_id === route.ditStepId);
  if (!step) return null;
  const component = step.slot.component;
  return { id: step.step.component_id, label: component?.label?.trim() || step.step.component_id, component };
}

/**
 * The route's reference video short edge (TE parameter reference_video_short_edge). The pipeline's TE step wins when
 * it sets the key (null included = official path), otherwise the TE component's stored invoke default — the same merge
 * order as the Node. Unset, null, 768 or not a number = official path → null.
 */
export function referenceVideoShortEdge(route: StudioRoute | null): number | null {
  const value = teParameter(route, REFERENCE_VIDEO_SHORT_EDGE_PARAM);
  return typeof value === "number" && Number.isFinite(value) && value !== OFFICIAL_REFERENCE_VIDEO_SHORT_EDGE ? value : null;
}

/** The TE step's value of a parameter: the pipeline step wins when it sets the key, otherwise the component's stored invoke default. */
function teParameter(route: StudioRoute | null, key: string): unknown {
  const te = route?.steps.find((item) => item.step.step_id === route.teStepId);
  if (!te) return undefined;
  const parameters: unknown = te.step.parameters;
  const invoke: unknown = te.slot.component?.settings.stored.invoke;
  return isRecord(parameters) && key in parameters ? parameters[key] : isRecord(invoke) ? invoke[key] : undefined;
}

/**
 * The route's reference image short edge (TE parameter reference_image_short_edge), the same merge order as the Node.
 * Unset, null or not a positive number = the official path → null (2048).
 */
export function referenceImageShortEdge(route: StudioRoute | null): number | null {
  const value = teParameter(route, REFERENCE_IMAGE_SHORT_EDGE_PARAM);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The short edge the route scales reference images to (px). */
export function routeImageEdge(route: StudioRoute | null): number {
  return referenceImageShortEdge(route) ?? REFERENCE_SHORT_EDGE;
}

export interface ResolvedSwapLimit extends SwapCapacity {
  ditId: string | null;
  ditLabel: string;
  /** Experimental reference video short edge; null on the official path. */
  referenceVideoShortEdge: number | null;
  /** Name used in limit texts: the DiT, plus「・參考影片 448」off the official path. */
  label: string;
  /** measured = the DiT's limits.swap; default = SWAP_DEFAULT_CAPACITY; trial = SWAP_TRIAL_CAPACITY (the user's choice, untested). */
  source: "measured" | "default" | "trial";
  /** Why the default (or a trial) is used (no route, no data, short edge not listed, invalid data); null when measured. */
  fallback: string | null;
  /** One-line summary of the limit. */
  text: string;
}

/**
 * Swap limits on this route: the DiT's declared capacity for the route's short edge, otherwise the conservative default
 * — or, when `trial` is set and the route has a DiT, the untested trial bounds.
 */
export function swapLimitsFor(route: StudioRoute | null, trial = false): ResolvedSwapLimit {
  const dit = routeDit(route);
  const edge = dit ? referenceVideoShortEdge(route) : null;
  const label = dit ? `${dit.label}${edge === null ? "" : t("・參考影片 {edge}", { edge })}` : t("未選擇的 DiT");
  const base = { ditId: dit?.id ?? null, ditLabel: dit?.label ?? t("未選擇"), referenceVideoShortEdge: edge, label };
  let fallback = t("還沒選運算路由（或元件組合沒有 DiT 步驟）");
  if (dit) {
    const parsed = parseSwapLimits(dit.component?.limits);
    const capacity = parsed.kind === "ok" ? (edge === null ? parsed.spec : parsed.spec.byReferenceShortEdge[edge]) : undefined;
    if (capacity) {
      const maxCharacters = Math.min(capacity.maxCharacters, MAX_SWAP_CHARACTERS);
      return {
        ...capacity,
        ...base,
        maxCharacters,
        source: "measured",
        fallback: null,
        text: capacity.maxFramesByCharacters
          ? t("{label}：{framesByCharactersText}", { label, framesByCharactersText: framesByCharactersText({ ...capacity, maxCharacters }) })
          : t("{label}：量測最多 {maxCharacters} 個角色、每段 {maxFrames} 影格", { label, maxCharacters, maxFrames: capacity.maxFrames }),
      };
    }
    fallback =
      parsed.kind === "invalid"
        ? t("這個 DiT（{id}）的換角上限設定有誤：{problem}", { id: dit.id, problem: parsed.problem })
        : parsed.kind === "ok" && edge !== null
          ? t("這個 DiT（{id}）在參考影片短邊 {edge} 還沒有量測換角上限", { id: dit.id, edge })
          : t("這個 DiT（{id}）還沒有量測換角上限", { id: dit.id });
  }
  if (trial && dit) {
    return {
      ...SWAP_TRIAL_CAPACITY,
      ...base,
      source: "trial",
      fallback,
      text: t("{label}：試跑，最多 {maxCharacters} 個角色、每段 {maxFrames} 影格（還沒量測）", { label, maxCharacters: SWAP_TRIAL_CAPACITY.maxCharacters, maxFrames: SWAP_TRIAL_CAPACITY.maxFrames }),
    };
  }
  return {
    ...SWAP_DEFAULT_CAPACITY,
    ...base,
    source: "default",
    fallback,
    text: t("{label}：最多 {maxCharacters} 個角色、每段 {maxFrames} 影格（保守的預設上限）", { label, maxCharacters: SWAP_DEFAULT_CAPACITY.maxCharacters, maxFrames: SWAP_DEFAULT_CAPACITY.maxFrames }),
  };
}

/** Why adding characters is disabled, or why too many characters block creation (frames: the limit at maxCharacters). */
export function characterLimitReason(limit: ResolvedSwapLimit): string {
  const frames = maxFramesFor(limit, limit.maxCharacters);
  const values = { maxCharacters: limit.maxCharacters, frames, seconds: segmentSeconds(frames) };
  if (limit.source === "trial") return t("試跑最多 {maxCharacters} 個角色（換角能放的角色數上限）", values);
  if (limit.fallback) return t("{fallback}，先用保守的預設上限：最多 {maxCharacters} 個角色、每段 {frames} 影格（{seconds} 秒）；打開「超過預設上限試跑」可以量測更多角色", { fallback: limit.fallback, ...values });
  if (limit.beyondLimit === "fails") return t("{beyondFails}：目前上限 {maxCharacters} 個角色、每段 {frames} 影格（{seconds} 秒）", { beyondFails: BEYOND_FAILS, ...values });
  return t("目前只量測過 {maxCharacters} 個角色、每段 {seconds} 秒；{notMeasuredYet}", { ...values, notMeasuredYet: NOT_MEASURED_YET });
}

/**
 * Lines of the wizard's limit note (characters: current count; frameLimit: maxFramesFor at that count; outputPixels: the
 * chosen picture's width × height, null when unknown).
 */
export function limitNoteItems(limit: ResolvedSwapLimit, current: { characters: number; frameLimit: number; outputPixels: number | null }): string[] {
  const switching = t("運算路由在「輸出與建立」選擇，上限跟著路由的 DiT 與參考影片短邊改變。");
  if (limit.source === "trial") {
    return [
      t("{fallback}：正在試跑超過預設的上限，最多 {maxCharacters} 個角色、每段 {maxFrames} 影格（{seconds} 秒）。", { fallback: limit.fallback ?? limit.label, maxCharacters: limit.maxCharacters, maxFrames: limit.maxFrames, seconds: segmentSeconds(limit.maxFrames) }),
      t("顯存不夠的段落會在 DiT 步驟失敗，已經完成的段落會保留。"),
      t("段落跑完後，在換角面板按「記錄成換角上限」，這張卡之後就用量測過的上限。"),
      switching,
    ];
  }
  if (limit.fallback) {
    return [
      t("{fallback}，先用保守的預設上限：最多 {maxCharacters} 個角色、每段 {maxFrames} 影格（{seconds} 秒）。", { fallback: limit.fallback, maxCharacters: limit.maxCharacters, maxFrames: limit.maxFrames, seconds: segmentSeconds(limit.maxFrames) }),
      t("打開「超過預設上限試跑」可以量測更多角色與更長的段落；跑完後會記成這張卡的上限。也可以在 DiT 元件的 limits.swap 直接設定（格式見元件定義的說明）。"),
      switching,
    ];
  }
  const byCount = limit.maxFramesByCharacters !== null;
  return [
    byCount ? t("{text}。", { text: limit.text }) : t("{text}（{seconds} 秒）。", { text: limit.text, seconds: segmentSeconds(limit.maxFrames) }),
    byCount && current.characters > 0 ? t("目前 {characters} 個角色：每段最多 {frameLimit} 影格（{seconds} 秒）。", { characters: current.characters, frameLimit: current.frameLimit, seconds: segmentSeconds(current.frameLimit) }) : "",
    limit.note ? t("量測說明：{note}", { note: limit.note }) : "",
    limit.maxOutputPixels !== null && current.outputPixels !== null && current.outputPixels > limit.maxOutputPixels
      ? t("這次的畫面（{current} 萬像素）比量測時（最多 {measured} 萬像素）大，可能顯存不足。", { current: (current.outputPixels / 10_000).toFixed(1), measured: (limit.maxOutputPixels / 10_000).toFixed(1) })
      : "",
    limit.beyondLimit === "fails" ? t("{beyondFails}。", { beyondFails: BEYOND_FAILS }) : t("{notMeasuredYet}。", { notMeasuredYet: NOT_MEASURED_YET }),
    switching,
  ].filter(Boolean);
}

/** Segments one batch run holds (each segment copies the route's steps, see MAX_RUN_STEPS); null without steps. */
export function segmentsPerRun(route: Pick<StudioRoute, "steps"> | null): number | null {
  const steps = route?.steps.length ?? 0;
  return steps > 0 ? Math.max(1, Math.floor(MAX_RUN_STEPS / steps)) : null;
}

/**
 * Generation-tab reminders for a ref2va shot with a reference video (never blocking; empty = within the limit or not
 * applicable): length (by reference image count), number of reference images and their preprocessed area. Without a
 * declared limit the only line says so — comparing against the conservative default would be a guess.
 */
export function refVideoMemoryWarnings(
  shot: { frames: number; references?: readonly StudioReference[]; continuity?: { mode: string } },
  library: readonly StudioLibraryItem[],
  route: StudioRoute | null,
): string[] {
  // A shot with a first frame (continuing the previous shot or a library image) is fl2va and sends no references
  if (!route || route.capability !== "ref2va" || (shot.continuity?.mode ?? "none") !== "none") return [];
  const references = shot.references ?? [];
  if (!references.some((ref) => ref.kind === "video")) return [];
  const limit = swapLimitsFor(route);
  if (limit.fallback) return [t("{fallback}：無法判斷這個鏡頭放不放得下（量測後可以在 DiT 元件的 limits.swap 設定）", { fallback: limit.fallback })];
  const items = new Map(library.map((item) => [item.item_id, item]));
  const images = references.filter((ref) => ref.kind === "image");
  const frameLimit = maxFramesFor(limit, images.length);
  const fails = limit.beyondLimit === "fails";
  const basis = t("{label} 量測可以跑完的", { label: limit.label });
  const longer = shot.frames > frameLimit;
  const more = images.length > limit.maxCharacters;
  const out: string[] = [];
  if (longer) {
    const unknown = fails ? "" : t("；更長的段落還沒量測，若顯存不足會在前置編碼跑完之後的 DiT 步驟才失敗");
    const count = limit.maxFramesByCharacters ? t("，參考圖 {imagesCount} 張", { imagesCount: images.length }) : "";
    out.push(t("這個鏡頭 {frames} 影格（{frames2} 秒）＋參考影片，超過{basis} {frameLimit} 影格（{frameLimit2} 秒{count}）{unknown}", { frames: shot.frames, frames2: segmentSeconds(shot.frames), basis, frameLimit, frameLimit2: segmentSeconds(frameLimit), count, unknown }));
  }
  if (more) {
    const unknown = fails ? "" : t("；每張圖都會預處理成短邊 {edge} px，更多張圖還沒量測", { edge: routeImageEdge(route) });
    out.push(t("參考圖片 {imagesCount} 張＋參考影片，超過{basis} {maxCharacters} 張{unknown}", { imagesCount: images.length, basis, maxCharacters: limit.maxCharacters, unknown }));
  }
  if ((longer || more) && fails) out.push(BEYOND_FAILS);
  const measuredArea = referenceAreaFor(limit, images.length);
  const area = preparedArea(
    images.map((ref) => ({ width: items.get(ref.item_id)?.width ?? null, height: items.get(ref.item_id)?.height ?? null })),
    routeImageEdge(route),
  );
  if (area !== null && measuredArea !== null && area > measuredArea && !more) out.push(AREA_WARNING);
  return out;
}
