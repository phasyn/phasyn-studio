// Playback of the one source loaded in the Source monitor: an HTML media element driven frame-accurately (seek to the
// middle of a frame), stopping at the marked Out point. Shuttle forward uses the element's playback rate; backwards
// the element is stepped, since browsers do not play media in reverse.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { t } from "@/i18n";
import type { SourceRange } from "../sourceMarks";

export interface SourcePlayback {
  /** Goes on the video or audio element (a still has none). The monitor is keyed by its media, so the element lives as long as the hook. */
  mediaRef: RefObject<HTMLMediaElement | null>;
  /** The ref callback for the <video> or <audio>: the media listeners follow the element as it mounts or changes. */
  attachMedia: (element: HTMLMediaElement | null) => void;
  frame: number;
  playing: boolean;
  /** Why the media cannot be shown or played; null while it can. */
  problem: string | null;
  seek: (frame: number) => void;
  toggle: () => void;
  shuttle: (direction: -1 | 0 | 1, slow: boolean) => void;
  /** The media or the image failed to load. */
  fail: () => void;
}

export interface SourcePlaybackInput {
  /** Frames of the source at the sequence rate. */
  total: number;
  fps: number;
  range: SourceRange;
  /** Called before this monitor starts playing (the sequence stops). */
  onPlay: () => void;
  onProblem: (message: string) => void;
}

export function useSourcePlayback({ total, fps, range, onPlay, onProblem }: SourcePlaybackInput): SourcePlayback {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // The element itself as state: the viewer mounts it only once its box is measured, after this hook's first effect
  const [element, setElement] = useState<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((next: HTMLMediaElement | null) => {
    mediaRef.current = next;
    setElement(next);
  }, []);
  const attempt = useRef(0);
  const pending = useRef(0);
  const reverse = useRef(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const stopReverse = () => {
    window.clearInterval(reverse.current);
    reverse.current = 0;
  };

  useEffect(() => {
    // Re-run whenever the element changes (`element`); the element itself is read from the ref, which may be written
    const media = mediaRef.current;
    if (!element || !media) return;
    let animation = 0;
    const read = () => {
      if (media.readyState < 1) return;
      const next = Math.max(0, Math.min(total - 1, Math.floor(media.currentTime * fps)));
      pending.current = next;
      setFrame(next);
      setPlaying((!media.paused && !media.ended) || reverse.current !== 0);
    };
    const tick = () => {
      if (media.currentTime * fps >= range.outFrame) {
        media.pause();
        media.currentTime = Math.max(0, range.outFrame - 0.5) / fps;
        read();
        return;
      }
      read();
      animation = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(animation);
      read();
      animation = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(animation);
      read();
    };
    const loaded = () => {
      if (pending.current > 0) media.currentTime = (pending.current + 0.5) / fps;
      read();
    };
    const visibility = () => {
      if (document.hidden) media.pause();
    };
    media.addEventListener("loadedmetadata", loaded);
    media.addEventListener("seeked", read);
    media.addEventListener("timeupdate", read);
    media.addEventListener("play", start);
    media.addEventListener("pause", stop);
    media.addEventListener("ended", stop);
    document.addEventListener("visibilitychange", visibility);
    if (media.readyState >= 1) loaded();
    return () => {
      cancelAnimationFrame(animation);
      window.clearInterval(reverse.current);
      reverse.current = 0;
      media.removeEventListener("loadedmetadata", loaded);
      media.removeEventListener("seeked", read);
      media.removeEventListener("timeupdate", read);
      media.removeEventListener("play", start);
      media.removeEventListener("pause", stop);
      media.removeEventListener("ended", stop);
      document.removeEventListener("visibilitychange", visibility);
      media.pause();
    };
  }, [element, fps, range.outFrame, total]);

  const seek = (position: number) => {
    const next = Math.max(0, Math.min(total - 1, Math.round(position)));
    attempt.current += 1;
    stopReverse();
    pending.current = next;
    const media = mediaRef.current;
    if (media) {
      media.pause();
      media.playbackRate = 1;
      if (media.readyState >= 1) media.currentTime = (next + 0.5) / fps;
    }
    setFrame(next);
    setPlaying(false);
  };

  const playAt = (rate: number) => {
    const media = mediaRef.current;
    if (!media || problem) return;
    stopReverse();
    onPlay();
    if (pending.current < range.inFrame || pending.current >= range.outFrame - 1) seek(range.inFrame);
    media.playbackRate = rate;
    const current = ++attempt.current;
    void media.play().catch((error: unknown) => {
      if (attempt.current !== current || (error instanceof DOMException && error.name === "AbortError")) return;
      const message = t("瀏覽器無法播放此素材；請確認格式與檔案是否可用");
      setProblem(message);
      onProblem(message);
    });
  };

  const pause = () => {
    attempt.current += 1;
    stopReverse();
    mediaRef.current?.pause();
    setPlaying(false);
  };

  const toggle = () => {
    const media = mediaRef.current;
    if (!media || problem) return;
    if (!media.paused || reverse.current !== 0) pause();
    else playAt(1);
  };

  const shuttle = (direction: -1 | 0 | 1, slow: boolean) => {
    const media = mediaRef.current;
    if (!media || problem) return;
    if (direction === 0) {
      pause();
      return;
    }
    if (direction > 0) {
      const running = !media.paused && reverse.current === 0;
      const faster = running && media.playbackRate >= 1 ? Math.min(4, media.playbackRate * 2) : 1;
      const slower = running && media.playbackRate < 1 ? Math.max(0.25, media.playbackRate / 2) : 0.5;
      playAt(slow ? slower : faster);
      return;
    }
    // Backwards: step the element at the frame rate (half speed when slow)
    attempt.current += 1;
    media.pause();
    stopReverse();
    onPlay();
    setPlaying(true);
    reverse.current = window.setInterval(
      () => {
        const next = pending.current - 1;
        if (next < 0) {
          stopReverse();
          setPlaying(false);
          return;
        }
        pending.current = next;
        if (media.readyState >= 1) media.currentTime = (next + 0.5) / fps;
        setFrame(next);
      },
      (1000 / fps) * (slow ? 2 : 1),
    );
  };

  const fail = () => {
    attempt.current += 1;
    stopReverse();
    mediaRef.current?.pause();
    setProblem(t("無法讀取來源素材，請到素材庫確認檔案"));
  };

  return { mediaRef, attachMedia, frame, playing, problem, seek, toggle, shuttle, fail };
}
