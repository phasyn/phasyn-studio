// Where the generation row's popovers and the reference tab's drop target are drawn, and in which box their fixed
// coordinates count. They go to document.body (the viewport), except inside a modal dialog (the professional prompt
// editor), where they go into the dialog itself so focus and the pointer stay inside it; a dialog that is moved with a
// transform, translate or backdrop filter places fixed children in its own box instead of the viewport.

/** Elements a keyboard reaches with Tab inside a popover. */
export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The layer a floating element of `anchor` is portaled into. */
export function floatingHost(anchor: Element): HTMLElement {
  return anchor.closest<HTMLElement>('[role="dialog"][data-state]') ?? document.body;
}

/** A computed style that makes the element the containing block of its fixed descendants. */
function placesFixedChildren(style: CSSStyleDeclaration): boolean {
  const set = (value: string) => value !== "" && value !== "none";
  if (set(style.transform) || set(style.translate) || set(style.scale) || set(style.rotate) || set(style.perspective)) return true;
  if (set(style.filter) || set(style.backdropFilter)) return true;
  return /paint|layout|strict|content/.test(style.contain) || (style.containerType !== "" && style.containerType !== "normal");
}

/** The box (viewport pixels) that a fixed child of `host` is positioned in. */
export function floatingFrame(host: HTMLElement): Frame {
  if (host === document.body || !placesFixedChildren(getComputedStyle(host))) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const rect = host.getBoundingClientRect();
  return { left: rect.left + host.clientLeft, top: rect.top + host.clientTop, width: host.clientWidth, height: host.clientHeight };
}

/** The focusable elements inside `root`, in tab order of the document. */
export function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest("[inert]")) : [];
}
