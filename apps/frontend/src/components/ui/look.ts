// Shared look recipes: class strings (written out in full, because Tailwind only scans literals) for panels, list rows,
// choice cards, tiles, HUD controls, tool buttons and meters. Tokens and utilities all come from index.css, the single
// token owner:
// - The brand gradient marks primary actions, the current position, progress and generation in flight. Data-dense
//   surfaces (tables, properties, records, code) stay crisp: no glow, blur or animated backgrounds. Status colors mean
//   status only.
// - Interaction: pressable shrinks to .97 and springs back (snappy); hover only changes color, cards and tiles also lift
//   1 px, thumbnails zoom 1.03 inside their frame; list items enter one after another with Motion (motion.reveal).
// - Only transform / opacity move; state never waits for an animation; motion is always on (no reduced-motion
//   fallback).

/** Spring timing (static @theme tokens): snappy for menus, sliders, press release, hover lift; smooth for panels. */
export const SPRING_SNAPPY = "duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)";
export const SPRING_SMOOTH = "duration-(--duration-spring-smooth) ease-(--ease-spring-smooth)";

/** Floating panel: 12 px radius, hairline border, surface fill; the border turns brand blue while focus is inside. */
export const PANEL =
  "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface shadow-edge transition-[border-color] duration-(--duration-base) ease-standard has-[:focus-visible]:border-brand-blue/55";
/** Primary panel (monitor, properties): adds a top light; at most two per workspace. */
export const PANEL_RAISED = `${PANEL} panel-raised`;
/** Panel title bar (36 px): same fill as the panel, hairline below. */
export const PANEL_HEADER = "flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-3";
export const PANEL_TITLE = "text-body font-semibold text-fg";
export const PANEL_ICON = "size-3.5 shrink-0 text-fg-tertiary";
/** Group card inside a panel: one step darker, hairline border, no glow. */
export const CARD = "rounded-lg border border-line-subtle bg-canvas/60";

/**
 * Selectable list row (shots, render queue, clips): when selected, a 3 px brand-gradient marker on the left and a soft
 * gradient fill; hover only tints, press darkens (rows never scale). The marker is ::before, so the row is relative.
 */
export const LIST_ROW =
  "relative transition-colors duration-(--duration-fast) ease-standard before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-linear-to-b before:from-brand-cyan before:via-brand-blue before:to-brand-violet before:opacity-0 before:transition-opacity before:duration-(--duration-fast) forced-colors:before:bg-[Highlight]";
export const LIST_ROW_SELECTED = "bg-brand-gradient-soft before:opacity-100";
export const LIST_ROW_IDLE = "hover:bg-raised/70 active:bg-sunken";

/** Static current-item marker (2 px vertical brand gradient) for rows that are always "current"; the row is relative. */
export const ROW_MARKER =
  "before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-linear-to-b before:from-brand-cyan before:via-brand-blue before:to-brand-violet";
/** Fill of the current row (separate from the keyboard focus ring). */
export const ROW_SELECTED = "bg-brand-gradient-soft";

/** Choice cards (size presets, routes, purposes, shots): shared border and press feedback. */
export const CHOICE_BASE = "pressable border";
/** Unselected choice: canvas fill, hairline border; hover brightens border and fill one step (no movement). */
export const CHOICE_IDLE = "border-line-subtle bg-canvas hover:border-line-strong hover:bg-raised/60";
/** Selected choice: soft brand fill and a 1 px gradient edge that follows the radius (no status color). */
export const CHOICE_SELECTED = "border-transparent bg-canvas bg-brand-gradient-soft border-brand-gradient";

/** Form option (radio-like cards): brand hairline and soft fill when selected; part of a form, so no glow or lift. */
export const OPTION_CARD = "rounded-lg border transition-[border-color,background-color] duration-(--duration-fast) ease-standard";
export const OPTION_SELECTED = "border-brand-blue/70 bg-brand-gradient-soft";
export const OPTION_IDLE = "border-line-subtle bg-canvas/60 hover:border-line-strong hover:bg-raised/60";

/** Small icon tile (section and card headers): neutral; brand moments use ICON_TILE_BRAND. */
export const ICON_TILE = "grid shrink-0 place-items-center rounded-md border border-line bg-raised text-fg-tertiary";
/** Brand icon tile (current sub-brand, primary flow): gradient fill, dark icon, soft glow. */
export const ICON_TILE_BRAND = "grid shrink-0 place-items-center rounded-md border border-transparent bg-brand-gradient text-on-accent shadow-glow-sm";
/** English sub-label (decorative, aria-hidden): wide-tracked capitals, short English only. */
export const EN_LABEL = "font-sans text-[10px] leading-3 font-semibold tracking-[0.2em] uppercase";
/** Count badge next to tabs and titles. */
export const COUNT = "machine text-caption font-normal text-fg-tertiary";

/** Hover lift for cards and tiles (1 px plus a deeper shadow, snappy spring). Not for table rows. */
export const LIFT =
  "transition-[translate,scale,box-shadow,border-color,background-color] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) hover:-translate-y-px hover:shadow-raised";
/** Thumbnail tile frame (group/tile; the zooming image stays inside). */
export const TILE = "group/tile overflow-hidden rounded-xl border border-line-subtle bg-canvas/60";
/** Photos-style zoom: the image grows to 1.03 inside its frame while the tile is hovered (the parent is TILE or another group/tile). */
export const THUMB_ZOOM = "transition-[scale] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-hover/tile:scale-[1.03]";
/** Media preview frame (monitor, comparisons): black stage, hairline, rounded. */
export const MEDIA_FRAME = "overflow-hidden rounded-xl border border-line-subtle bg-stage";

/** Floating controls over images and video (QuickTime-style HUD): translucent, blurred, hairline light edge. */
export const HUD = "material-hud rounded-xl ring-1 ring-white/10 shadow-popover";
/** Small label over an image (take number, preview note). */
export const HUD_CHIP = "material-hud rounded-full border border-white/10 px-2 py-0.5 text-caption text-fg shadow-[0_1px_2px_rgb(0_0_0/0.4)]";
/** Icon button over an image (thumbnail quick actions). */
export const HUD_BUTTON =
  "pressable material-hud inline-flex size-7 items-center justify-center rounded-full border border-white/10 text-fg hover:border-white/25 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-focus aria-disabled:cursor-not-allowed aria-disabled:text-fg-disabled [&_svg]:size-3.5";

/** 28 px icon tool button: hover tints, press is pressable. */
export const TOOL_BUTTON =
  "pressable inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-raised hover:text-fg active:bg-sunken disabled:cursor-not-allowed disabled:text-fg-disabled disabled:hover:bg-transparent [&_svg]:size-3.5";
/** A tool button that is on (aria-pressed): soft brand fill, brand ring, cyan icon. */
export const TOOL_BUTTON_ON = "bg-brand-gradient-soft text-fg ring-1 ring-brand-blue/50 ring-inset hover:bg-brand-gradient-soft hover:text-fg [&_svg]:text-brand-cyan";
/** Main play button of a monitor: brand-gradient round button (glow on hover or focus). */
export const PLAY_BUTTON =
  "pressable inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-on-accent shadow-edge hover:shadow-glow-sm hover:brightness-110 focus-visible:shadow-glow-sm disabled:cursor-not-allowed disabled:bg-raised disabled:bg-none disabled:text-fg-disabled disabled:shadow-none disabled:hover:brightness-100 [&_svg]:size-4";

/** Thin meter: track plus a brand-gradient fill whose width moves linearly (progress never springs). */
export const METER_TRACK = "relative block h-1 overflow-hidden rounded-full bg-line-subtle";
export const METER_FILL = "absolute inset-y-0 left-0 rounded-full bg-brand-gradient transition-[width] duration-(--duration-base) ease-linear";
/** Highlight sweeping over a gradient while work is in flight (visible on bg-brand-gradient / bg-brand-gradient-soft). */
export const SHIMMER = "animate-shimmer";

/** A dragged clip lifts: scale 1.02 and a 0.5° tilt (list scale and rotate in the transition; transition-transform excludes rotate). */
export const DRAG_LIFT = "scale-[1.02] rotate-[0.5deg]";

/** Entrance of a single element: fade in, rise and settle (smooth spring). List items use motion.reveal(index) instead. */
export const RISE_IN = "animate-rise-in";
