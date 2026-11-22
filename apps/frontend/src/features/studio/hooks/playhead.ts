// 播放頭：序列時間（幀）與播放狀態的外部 store。播放時每個畫面都會更新，只讓訂閱的元件（timecode、
// 時間軸播放頭）重繪，不讓整個 Studio 跟著 render。
import { useSyncExternalStore } from "react";

export interface PlayheadStore {
  getFrame: () => number;
  setFrame: (frame: number) => void;
  isPlaying: () => boolean;
  setPlaying: (playing: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlayheadStore(): PlayheadStore {
  let frame = 0;
  let playing = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    getFrame: () => frame,
    setFrame(next) {
      const value = Math.max(0, Math.round(next));
      if (value === frame) return;
      frame = value;
      emit();
    },
    isPlaying: () => playing,
    setPlaying(next) {
      if (next === playing) return;
      playing = next;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function usePlayheadFrame(store: PlayheadStore): number {
  return useSyncExternalStore(store.subscribe, store.getFrame);
}

export function usePlaying(store: PlayheadStore): boolean {
  return useSyncExternalStore(store.subscribe, store.isPlaying);
}
