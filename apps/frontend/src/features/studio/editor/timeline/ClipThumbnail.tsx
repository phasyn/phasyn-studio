// The head thumbnail of a video clip on a medium or large track, as Premiere draws it: the frame the clip starts with,
// at its left edge under the clip's name, in the media's shape. A frame is captured only once the clip has been on
// screen and never while a drag or a trim is under way (a thumbnail already captured still shows); an image shows
// itself. It fades in when it is ready.
import { useEffect, useRef, useState } from "react";
import type { TimelineClip, TimelineSource } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { sourceFrameAtTimeline } from "../model";
import { useHeadThumbnail } from "./headThumbnails";

/** Below this width the thumbnail would be a sliver: it is left out. */
const MIN_WIDTH = 16;

export interface ClipThumbnailProps {
  clip: TimelineClip;
  source: TimelineSource;
  fps: number;
  /** Height of the thumbnail in px. */
  height: number;
  /** Distance from the clip bar's left edge in px (room for a transition drawn over the clip's start). */
  left: number;
  /** No new capture starts (a gesture is under way). */
  paused: boolean;
}

export function ClipThumbnail({ clip, source, fps, height, left, paused }: ClipThumbnailProps) {
  const frameRef = useRef<HTMLSpanElement>(null);
  // Captured only for clips that have been on screen: a long sequence does not decode every clip at once
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setSeen(true);
      observer.disconnect();
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, []);
  const url = source.file ? mediaUrl(source.file.node_id, source.file.file_id) : null;
  const still = source.kind === "image";
  const head = Math.max(0, Math.round(sourceFrameAtTimeline(clip, clip.start_frame)));
  const captured = useHeadThumbnail(seen && !still ? url : null, head, fps, paused);
  const picture = still ? (seen ? url : null) : captured;
  const aspect = source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9;
  const width = Math.round(height * aspect);
  if (width < MIN_WIDTH || height < MIN_WIDTH) return null;
  return (
    <span ref={frameRef} aria-hidden className="pointer-events-none absolute top-[22px] overflow-hidden rounded-[3px]" style={{ left, width, height }}>
      {(picture != null && picture !== "") ? <img src={picture} alt="" draggable={false} decoding="async" className="size-full animate-fade-in object-cover" /> : null}
    </span>
  );
}
