// The sequence transport, shared by both workspaces: the playhead clock (linear, never eased), the shuttle rate and the
// audio graph of the Program viewer. Playback only runs while a Program viewer is mounted (it holds the media), so the
// last viewer to leave stops it; the playhead frame stays where it is.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayheadStore } from "../hooks/playhead";
import { usePlaying } from "../hooks/playhead";
import type { MonitorMode } from "../studioContext";
import { createMonitorAudio, type MonitorAudio } from "./audio";
import { popoutVisible } from "./monitors/popout";

export interface Transport {
  audio: MonitorAudio;
  /** Shuttle rate: 1 = forward at speed, negative = reverse; slow shuttle is below 1. */
  rate: number;
  /** Start playing (speed 1 forward; from the start when the playhead is at the end). */
  play: (speed?: number) => void;
  stop: () => void;
  toggle: () => void;
  /** Stop and move the playhead (clamped to the sequence; its end, one past the last frame, included). */
  seek: (frame: number) => void;
  step: (frames: number) => void;
  /** J / L: start in that direction, then double the rate on each press (up to 4×); slow starts at half speed and halves. */
  shuttle: (direction: -1 | 1, slow?: boolean) => void;
  /** Called by a mounted Program viewer; returns its detach function. */
  attach: () => () => void;
}

export interface TransportInput {
  playhead: PlayheadStore;
  totalFrames: number;
  fps: number;
  setMonitorMode: (mode: MonitorMode) => void;
  onAudioBlocked: () => void;
}

export function useTransport({ playhead, totalFrames, fps, setMonitorMode, onAudioBlocked }: TransportInput): Transport {
  const [audio] = useState(createMonitorAudio);
  const [rate, setRate] = useState(1);
  const playing = usePlaying(playhead);
  const intentRef = useRef(0);
  const viewersRef = useRef(0);
  const liveRef = useRef({ totalFrames, rate, onAudioBlocked });
  useEffect(() => {
    liveRef.current = { totalFrames, rate, onAudioBlocked };
  });

  const stop = useCallback(() => {
    intentRef.current += 1;
    playhead.setPlaying(false);
  }, [playhead]);

  const play = useCallback(
    (speed = 1) => {
      const total = liveRef.current.totalFrames;
      if (total === 0) return;
      const frame = playhead.getFrame();
      if ((speed > 0 && frame >= total - 1) || (speed < 0 && frame === 0)) playhead.setFrame(speed > 0 ? 0 : total - 1);
      setRate(speed);
      setMonitorMode("program");
      const attempt = ++intentRef.current;
      audio
        .start()
        .then(() => {
          if (intentRef.current === attempt) playhead.setPlaying(true);
        })
        .catch(() => { liveRef.current.onAudioBlocked(); });
    },
    [audio, playhead, setMonitorMode],
  );

  const seek = useCallback(
    (frame: number) => {
      stop();
      setMonitorMode("program");
      // The playhead may park on the end of the sequence (one past the last frame), where an edit appends
      playhead.setFrame(Math.max(0, Math.min(liveRef.current.totalFrames, Math.round(frame))));
    },
    [playhead, setMonitorMode, stop],
  );

  const toggle = useCallback(() => {
    if (playhead.isPlaying()) stop();
    else play();
  }, [play, playhead, stop]);

  const step = useCallback((frames: number) => { seek(playhead.getFrame() + frames); }, [playhead, seek]);

  const shuttle = useCallback(
    (direction: -1 | 1, slow = false) => {
      const current = liveRef.current.rate;
      const same = playhead.isPlaying() && Math.sign(current) === direction;
      if (slow) play(direction * (same && Math.abs(current) < 1 ? Math.max(0.25, Math.abs(current) / 2) : 0.5));
      else play(direction * (same && Math.abs(current) >= 1 ? Math.min(4, Math.abs(current) * 2) : 1));
    },
    [play, playhead],
  );

  const attach = useCallback(() => {
    viewersRef.current += 1;
    return () => {
      viewersRef.current -= 1;
      if (viewersRef.current === 0) stop();
    };
  }, [stop]);

  // The clock: frames advance with real time at the sequence rate; the last frame ends playback
  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    // The first frame only sets the clock: a frame's timestamp can lie before the moment playback was started
    let previous: number | null = null;
    let position = playhead.getFrame();
    const tick = (now: number) => {
      // A hidden page stops playback, unless the Program monitor shows in its own window
      if (document.hidden && !popoutVisible()) {
        playhead.setPlaying(false);
        return;
      }
      position += (Math.max(0, now - (previous ?? now)) / 1000) * fps * rate;
      previous = now;
      if (position >= totalFrames || position < 0) {
        playhead.setFrame(Math.max(0, Math.min(totalFrames - 1, position)));
        playhead.setPlaying(false);
        return;
      }
      playhead.setFrame(Math.floor(position));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(handle); };
  }, [fps, playing, playhead, rate, totalFrames]);

  useEffect(
    () => () => {
      intentRef.current += 1;
      playhead.setPlaying(false);
      void audio.close();
    },
    [audio, playhead],
  );

  return useMemo(() => ({ audio, rate, play, stop, toggle, seek, step, shuttle, attach }), [audio, rate, play, stop, toggle, seek, step, shuttle, attach]);
}
