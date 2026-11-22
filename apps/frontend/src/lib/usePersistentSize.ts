import { isListed } from "@/lib/json";
// 面板尺寸與開合：這台瀏覽器的偏好（localStorage）；讀寫失敗（私密模式、停用儲存）時用預設值，不影響功能。
// Storage keys: `phasyn.<kind>.<key>` with kind panel (sizes), flag, choice or set; callers pass a key that is unique
// app-wide, namespaced by area when needed (e.g. "studio.timeline.zoom" → phasyn.panel.studio.timeline.zoom).
import { useCallback, useState } from "react";

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 只在這次工作階段生效
  }
}

/**
 * A size kept in this browser, clamped to [min, max] and rounded to `decimals` places (default whole numbers; e.g.
 * 2 for a timeline zoom, so small trackpad pinches are not rounded away). Non-finite updates are ignored.
 */
export function usePersistentSize(key: string, fallback: number, min: number, max: number, decimals = 0) {
  const storageKey = `phasyn.panel.${key}`;
  const [size, setSize] = useState(() => readNumber(storageKey, fallback, min, max));
  const update = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return;
      const factor = 10 ** decimals;
      const value = Math.round(Math.min(max, Math.max(min, next)) * factor) / factor;
      setSize(value);
      write(storageKey, String(value));
    },
    [storageKey, min, max, decimals],
  );
  return [size, update] as const;
}

export function usePersistentFlag(key: string, fallback: boolean) {
  const storageKey = `phasyn.flag.${key}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw === null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      write(storageKey, next ? "1" : "0");
    },
    [storageKey],
  );
  return [value, update] as const;
}

/** 從固定選項中選一個（例如 dock 目前分頁）；儲存值不在選項內時用預設值。 */
export function usePersistentChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const storageKey = `phasyn.choice.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return isListed(raw, allowed) ? raw : fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      write(storageKey, next);
    },
    [storageKey],
  );
  return [(allowed as readonly string[]).includes(value) ? value : fallback, update] as const;
}

/** 字串集合（例如樹的展開項目）。 */
export function usePersistentSet(key: string, fallback: readonly string[]) {
  const storageKey = `phasyn.set.${key}`;
  const [value, setValue] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : fallback);
    } catch {
      return new Set(fallback);
    }
  });
  const update = useCallback(
    (next: ReadonlySet<string>) => {
      setValue(next);
      write(storageKey, JSON.stringify([...next]));
    },
    [storageKey],
  );
  return [value, update] as const;
}
