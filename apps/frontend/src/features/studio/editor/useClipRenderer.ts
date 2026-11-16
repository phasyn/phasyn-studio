import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { t } from "@/i18n";
import { createClipRenderer, type ClipPicture, type ClipRenderFrame, type ClipRenderer } from "./clipRenderer";

export interface ClipRendererOptions {
  /** What the layer draws from (default: its media element). */
  picture?: ClipPicture;
  /** An adjustment layer: the canvas its picture is, and what fills it with the composite below before each draw. */
  composite?: { canvas: HTMLCanvasElement; compose: () => void } | null;
  /** Keep the drawn picture readable after it is shown: an adjustment layer above reads it. */
  readable?: boolean;
  /** After every draw (an adjustment layer above follows the layer). */
  onDraw?: () => void;
}

export interface ClipRendererState {
  /** Why the preview of the layer cannot be drawn; null while it can. */
  failure: string | null;
  /** Draw again on the next animation frame (several requests make one draw; a draw for a new frame cancels it). */
  requestDraw: () => void;
}

/** Lifecycle adapter only: the render pipeline itself owns no React state or playback clock. */
export function useClipRenderer(
  canvas: RefObject<HTMLCanvasElement | null>,
  video: RefObject<HTMLVideoElement | null>,
  image: RefObject<HTMLImageElement | null>,
  url: string | undefined,
  width: number,
  height: number,
  enabled: boolean,
  frame: ClipRenderFrame,
  options: ClipRendererOptions = {},
): ClipRendererState {
  const renderer = useRef<ClipRenderer | null>(null);
  const latest = useRef(frame);
  const hooks = useRef(options);
  const pending = useRef(0);
  const picture = options.picture ?? "media";
  const composite = options.composite?.canvas ?? null;
  const readable = options.readable === true;
  const [failure, setFailure] = useState<string | null>(null);
  // The latest compose and onDraw for every draw, also one started by a media event
  useLayoutEffect(() => {
    hooks.current = options;
  });
  const paint = useCallback(() => {
    cancelAnimationFrame(pending.current);
    pending.current = 0;
    const current = renderer.current;
    if (!current) return;
    hooks.current.composite?.compose();
    current.draw(latest.current);
    hooks.current.onDraw?.();
  }, []);
  useLayoutEffect(() => {
    latest.current = frame;
    paint();
  }, [frame, paint]);
  useEffect(() => {
    const target = canvas.current;
    const media = picture === "text" ? document.createElement("canvas") : picture === "composite" ? composite : (image.current ?? video.current);
    if (!enabled || !target || !media || (!url && picture === "media")) return;
    let active = true;
    const fail = () => {
      if (active) setFailure(t("無法建立影像效果預覽，請重新載入剪輯工作區"));
    };
    const draw = () => {
      if (active) paint();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      fail();
    };
    const restored = () => {
      if (active) {
        setFailure(null);
        draw();
      }
    };
    try {
      renderer.current = createClipRenderer(target, media, width, height, { picture, readable });
      draw();
    } catch {
      queueMicrotask(fail);
    }
    target.addEventListener("webglcontextlost", lost);
    target.addEventListener("webglcontextrestored", restored);
    media.addEventListener("loadeddata", draw);
    media.addEventListener("load", draw);
    media.addEventListener("seeked", draw);
    void document.fonts.ready.then(draw);
    return () => {
      active = false;
      cancelAnimationFrame(pending.current);
      pending.current = 0;
      target.removeEventListener("webglcontextlost", lost);
      target.removeEventListener("webglcontextrestored", restored);
      media.removeEventListener("loadeddata", draw);
      media.removeEventListener("load", draw);
      media.removeEventListener("seeked", draw);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [canvas, video, image, url, width, height, enabled, picture, composite, readable, paint]);
  const requestDraw = useCallback(() => {
    if (pending.current === 0) pending.current = requestAnimationFrame(paint);
  }, [paint]);
  return { failure, requestDraw };
}
