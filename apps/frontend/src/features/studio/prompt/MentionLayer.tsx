// The highlight layer under a mention textarea: the same text, laid out with the textarea's own text metrics in a box
// that matches the textarea's text box (measured from its content box, so the scrollbar and fractional widths match),
// moved by the textarea's scroll offset. The text itself is transparent, so only the marks paint, under the textarea's
// own glyphs: a tinted capsule behind an @ name that resolves to a reference (amber when its file left the library) and
// a red dashed underline under one that resolves to nothing. The textarea above keeps typing, selection, input methods
// and scrolling exactly as a textarea does; this layer never takes pointer events and is hidden from assistive
// technology (the names are in the text itself).
import { useLayoutEffect, useRef, type RefObject } from "react";
import { markSegments, type MentionMark } from "./mentionMarks";

/** Text-layout properties copied from the textarea: everything that can move a glyph. */
const TEXT_STYLE = [
  "direction",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "font-optical-sizing",
  "font-size-adjust",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "text-rendering",
  "tab-size",
  "white-space",
  "text-wrap-style",
  "word-break",
  "overflow-wrap",
  "line-break",
  "hyphens",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

const RESOLVED = "rounded-sm bg-brand-cyan/16 shadow-[0_0_0_2px_rgb(73_207_255_/_0.16),0_0_0_3px_rgb(73_207_255_/_0.34)]";
const MISSING_FILE = "rounded-sm bg-warning/16 shadow-[0_0_0_2px_rgb(235_192_122_/_0.16),0_0_0_3px_rgb(235_192_122_/_0.36)]";
const UNRESOLVED = "underline decoration-danger decoration-dashed decoration-[1.5px] underline-offset-[3px] [text-decoration-skip-ink:none]";

function px(value: string): number {
  return Number.parseFloat(value) || 0;
}

/**
 * The textarea's content box from its layout (fractional; the scrollbar left out), for the first alignment: the
 * resize observer reports the exact box afterwards, before anything is painted.
 */
function contentBox(textarea: HTMLTextAreaElement, computed: CSSStyleDeclaration): { width: number; height: number } {
  const borderX = px(computed.borderLeftWidth) + px(computed.borderRightWidth);
  const borderY = px(computed.borderTopWidth) + px(computed.borderBottomWidth);
  const scrollbarX = Math.max(0, textarea.offsetWidth - textarea.clientWidth - Math.round(borderX));
  const scrollbarY = Math.max(0, textarea.offsetHeight - textarea.clientHeight - Math.round(borderY));
  return {
    width: px(computed.width) - borderX - px(computed.paddingLeft) - px(computed.paddingRight) - scrollbarX,
    height: px(computed.height) - borderY - px(computed.paddingTop) - px(computed.paddingBottom) - scrollbarY,
  };
}

/** Copies the text metrics and lays the layer over the textarea's text box (content box plus padding, no scrollbar). */
function align(textarea: HTMLTextAreaElement, layer: HTMLElement, content: HTMLElement, contentWidth: number, contentHeight: number): void {
  const computed = getComputedStyle(textarea);
  for (const name of TEXT_STYLE) content.style.setProperty(name, computed.getPropertyValue(name));
  const width = contentWidth + px(computed.paddingLeft) + px(computed.paddingRight);
  const height = contentHeight + px(computed.paddingTop) + px(computed.paddingBottom);
  layer.style.left = `${String(textarea.offsetLeft + textarea.clientLeft)}px`;
  layer.style.top = `${String(textarea.offsetTop + textarea.clientTop)}px`;
  layer.style.width = `${String(width)}px`;
  layer.style.height = `${String(height)}px`;
  content.style.width = `${String(width)}px`;
}

function follow(textarea: HTMLTextAreaElement, content: HTMLElement): void {
  content.style.transform = `translate(${String(-textarea.scrollLeft)}px, ${String(-textarea.scrollTop)}px)`;
}

export function MentionLayer({
  textarea,
  contentRef,
  text,
  marks,
  missing,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** The element holding the marks (the hover card reads their boxes from it). */
  contentRef: RefObject<HTMLDivElement | null>;
  text: string;
  marks: readonly MentionMark[];
  /** Resolved names whose file is no longer in the library. */
  missing: ReadonlySet<string>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);

  // Size and metrics follow the textarea's content box: aligned now (a card placed in this commit reads the marks) and
  // again on every report of the resize observer; the scroll offset follows the textarea's scroll events
  useLayoutEffect(() => {
    const node = textarea.current;
    const layer = layerRef.current;
    const content = contentRef.current;
    if (!node || !layer || !content) return;
    const first = contentBox(node, getComputedStyle(node));
    align(node, layer, content, first.width, first.height);
    follow(node, content);
    const onScroll = () => { follow(node, content); };
    node.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => { node.removeEventListener("scroll", onScroll); };
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (!box) return;
      align(node, layer, content, box.width, box.height);
      follow(node, content);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", onScroll);
    };
  }, [textarea, contentRef]);

  // Typing can scroll the textarea (to keep the caret in view) or shorten it under the scroll offset
  useLayoutEffect(() => {
    const node = textarea.current;
    const content = contentRef.current;
    if (node && content) follow(node, content);
  }, [textarea, contentRef, text]);

  return (
    <div ref={layerRef} aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-hidden select-none">
      <div ref={contentRef} className="text-transparent">
        {markSegments(text, marks).map((segment) => {
          const mark = segment.mark === null ? undefined : marks[segment.mark];
          if (!mark) return segment.text;
          return (
            <span
              key={mark.start}
              data-mark-start={mark.start}
              data-resolved={mark.resolved ? "" : undefined}
              className={mark.resolved ? (missing.has(mark.alias) ? MISSING_FILE : RESOLVED) : UNRESOLVED}
            >
              {segment.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
