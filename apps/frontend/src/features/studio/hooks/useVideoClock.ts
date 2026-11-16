// Playback clock of a <video>: video events plus requestAnimationFrame while playing. The state only changes when what
// the monitor shows changes (the frame index at the project fps, the duration or the playing flag), so the monitor does
// not re-render on every animation frame.
import { useEffect, useState, type RefObject } from "react";

export interface VideoClock {
  /** Current frame: currentTime × fps, rounded. */
  frame: number;
  /** Duration in seconds; 0 until the metadata is known. */
  duration: number;
  playing: boolean;
}

const STOPPED: VideoClock = { frame: 0, duration: 0, playing: false };

/** Clock of the raw video state. */
export function clockFrom(video: Pick<HTMLVideoElement, "currentTime" | "duration" | "paused" | "ended">, fps: number): VideoClock {
  return { frame: Math.round(video.currentTime * fps), duration: Number.isFinite(video.duration) ? video.duration : 0, playing: !video.paused && !video.ended };
}

/** The state to keep: the current object when nothing visible changed (React then skips the render). */
export function nextClock(current: VideoClock, reading: VideoClock): VideoClock {
  return current.frame === reading.frame && current.duration === reading.duration && current.playing === reading.playing ? current : reading;
}

/** Tracks the video's position (the animation-frame loop only runs while playing). */
export function useVideoClock(ref: RefObject<HTMLVideoElement | null>, src: string | null, fps: number): VideoClock {
  const [clock, setClock] = useState(STOPPED);
  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;
    let raf = 0;
    const read = () => {
      const reading = clockFrom(video, fps);
      setClock((current) => nextClock(current, reading));
    };
    const loop = () => {
      read();
      raf = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    const onStop = () => {
      cancelAnimationFrame(raf);
      read();
    };
    const events = ["loadedmetadata", "durationchange", "seeked", "timeupdate"] as const;
    for (const name of events) video.addEventListener(name, read);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onStop);
    video.addEventListener("ended", onStop);
    raf = requestAnimationFrame(read);
    return () => {
      cancelAnimationFrame(raf);
      for (const name of events) video.removeEventListener(name, read);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onStop);
      video.removeEventListener("ended", onStop);
    };
  }, [ref, src, fps]);
  return clock;
}
