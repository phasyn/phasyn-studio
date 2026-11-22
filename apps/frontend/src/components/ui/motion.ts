import { nonEmptyText } from "@/lib/json";
// 介面動作（motion）的 DOM 端，引擎是 Motion（motion.dev）：以 token 播放動畫、清單逐項進場、分頁指示線、內容切換淡入、
// 狀態變化淡入、面板開合、清單補位（FLIP）。時間、曲線與位移一律讀 index.css 的 token（--duration-*、--ease-*、
// --motion-shift*），這裡只把它們轉成 Motion 的 transition，不另訂數值（下面的預設只在讀不到 CSS 變數時使用，與 index.css 相同）。
// 規則：語意狀態（開關、選取、資料、焦點）永遠先改、立即生效；動畫只負責呈現，不等動畫結束、不移動焦點。
// 動態一律開啟：不讀 prefers-reduced-motion，也沒有開關（每段動畫都明確傳 reduceMotion: false）。
import { animate, type DOMKeyframesDefinition, type Easing, type Transition } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefCallback, type RefObject } from "react";
import { flushSync } from "react-dom";
import { indicatorPlacement, indicatorTransform, parseCssDuration, parseCssPixels, type IndicatorAxis } from "./motionModel";

/** Maximum stagger index: items after the tenth enter together. */
export const STAGGER_LIMIT = 10;
/** Delay between two list items entering in sequence (the same step index.css uses for the stagger utility). */
const STAGGER_STEP_MS = 24;

export type MotionDuration = "fast" | "base" | "slow" | "exit" | "spring-smooth" | "spring-snappy" | "spring-bouncy";
export type MotionEasing = "standard" | "enter" | "exit" | "spring-smooth" | "spring-snappy" | "spring-bouncy";

const FALLBACK_MS: Record<MotionDuration, number> = {
  fast: 120,
  base: 180,
  slow: 240,
  exit: 140,
  "spring-smooth": 620,
  "spring-snappy": 440,
  "spring-bouncy": 720,
};

function token(name: string): string {
  return typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** token 的毫秒數（--duration-fast／base／slow／exit）。 */
export function motionDuration(name: MotionDuration): number {
  return parseCssDuration(token(`--duration-${name}`)) ?? FALLBACK_MS[name];
}

/**
 * 曲線 token → Motion 的 easing：`cubic-bezier(...)` 給四個數字；`linear(...)` 是均勻取樣的彈簧，線性內插就等於 CSS 的曲線
 * （Motion 播放時會再轉回 linear() 交給瀏覽器）。讀不懂時回 null。
 */
export function easeFromToken(raw: string): Easing | null {
  const match = /^(linear|cubic-bezier)\((.*)\)$/.exec(raw.trim());
  const values = match?.[2]?.split(",").map((value) => Number(value.trim())) ?? [];
  if (!match || values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  if (match[1] === "cubic-bezier") {
    const [x1, y1, x2, y2] = values;
    return values.length === 4 && x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined
      ? [x1, y1, x2, y2] : null;
  }
  const last = values.length - 1;
  return (t: number) => {
    const position = Math.min(Math.max(t, 0), 1) * last;
    const index = Math.min(Math.floor(position), last - 1);
    const start = values[index] ?? 0;
    return start + ((values[index + 1] ?? start) - start) * (position - index);
  };
}

/** token 組成的 Motion transition（秒）。delayMs 是額外的延遲（清單逐項進場）。 */
export function motionTransition(duration: MotionDuration, easing: MotionEasing, delayMs = 0): Transition {
  return {
    duration: motionDuration(duration) / 1000,
    ease: easeFromToken(token(`--ease-${easing}`)) ?? "easeOut",
    delay: delayMs / 1000,
  };
}

/** 位移 token（px）：shift＝內容與選單 4 px，panel＝面板與通知 8 px。 */
function motionShift(kind: "shift" | "panel"): number {
  return parseCssPixels(token(kind === "shift" ? "--motion-shift" : "--motion-shift-panel")) ?? (kind === "shift" ? 4 : 8);
}

export interface MotionSpec {
  duration: MotionDuration;
  easing: MotionEasing;
}

/** playMotion 的回傳：可取消（cancel 回到元素自己的樣式）。 */
export interface MotionHandle {
  cancel(): void;
  stop(): void;
}

/** 單位變換：把 transform 函式清單的每個值換成不變的值（translate 0px、scale 1、rotate／skew 0deg）。 */
function identityTransform(list: string): string {
  return list.replace(/([a-zA-Z0-9]+)\(([^)]*)\)/g, (_match, fn: string, args: string) => {
    const count = args.split(",").length;
    const value = fn.startsWith("scale") ? "1" : fn.startsWith("translate") ? "0px" : fn.startsWith("rotate") || fn.startsWith("skew") ? "0deg" : null;
    if (fn === "matrix") return "matrix(1, 0, 0, 1, 0, 0)";
    return value === null ? `${fn}(${args})` : `${fn}(${Array.from({ length: count }, () => value).join(", ")})`;
  });
}

/**
 * 起點與終點（每個屬性一組 [from, to]），例如 [{ opacity: 0 }, { opacity: 1 }]。transform 的 "none" 換成與另一端同一組函式的
 * 單位變換：Motion 從函式清單補間到 "none" 時會把每個函式當成 0（scale 變成 0，元素縮成看不見）。
 */
function toMotionKeyframes(frames: readonly Record<string, string | number>[]): DOMKeyframesDefinition {
  const out: Record<string, (string | number)[]> = {};
  for (const frame of frames) for (const [key, value] of Object.entries(frame)) (out[key] ??= []).push(value);
  const transforms = out["transform"];
  const list = transforms?.find((value) => typeof value === "string" && value !== "none");
  if (transforms && typeof list === "string") out["transform"] = transforms.map((value) => (value === "none" ? identityTransform(list) : value));
  return out;
}

const cssName = (property: string) => property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

interface InlineOriginal {
  value: string;
  priority: string;
  /** Motion 動畫中、還沒結束的段數；歸零時（再晚一格，排在 Motion 寫入終點之後）還原成 value。 */
  active: number;
}

/** 每個元素每個屬性在第一段動畫開始前的 inline 值（重疊或接手的動畫共用同一份）。 */
const inlineOriginals = new WeakMap<Element, Map<string, InlineOriginal>>();

function holdInline(element: HTMLElement | SVGElement, names: readonly string[], restore: Readonly<Record<string, string>>): Map<string, InlineOriginal> {
  let held = inlineOriginals.get(element);
  if (!held) {
    held = new Map<string, InlineOriginal>();
    inlineOriginals.set(element, held);
  }
  for (const name of names) {
    let entry = held.get(name);
    if (!entry) {
      const override = Object.entries(restore).find(([property]) => cssName(property) === name)?.[1];
      entry = { value: override ?? element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name), active: 0 };
      held.set(name, entry);
    }
    entry.active += 1;
  }
  return held;
}

function releaseInline(element: HTMLElement | SVGElement, held: Map<string, InlineOriginal>, names: readonly string[]): void {
  for (const name of names) {
    const entry = held.get(name);
    if (!entry) continue;
    entry.active -= 1;
    if (entry.active > 0) continue;
    held.delete(name);
    if (entry.value) element.style.setProperty(name, entry.value, entry.priority);
    else element.style.removeProperty(name);
  }
}

/**
 * 以 Motion 播放一段 token 動畫。最後一段結束、取消或被接手後，元素的 inline 樣式還原成第一段開始前的值（Motion 結束時
 * 會把終點寫進 inline 樣式；還原在下一格做，排在那次寫入之後），之後的狀態改變不會被蓋住。
 * restore 指定某些屬性要還原成的值（例如進場前才設的起點）。元素不在或無法播放時回傳 null。
 */
export function playMotion(
  element: Element | null | undefined,
  keyframes: readonly Record<string, string | number>[],
  spec: MotionSpec & { delayMs?: number },
  restore: Readonly<Record<string, string>> = {},
): MotionHandle | null {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return null;
  const names = [...new Set(keyframes.flatMap((frame) => Object.keys(frame)))].map(cssName);
  const held = holdInline(element, names, restore);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    requestAnimationFrame(() => { releaseInline(element, held, names); });
  };
  try {
    const animation = animate(element, toMotionKeyframes(keyframes), { ...motionTransition(spec.duration, spec.easing, spec.delayMs), reduceMotion: false });
    animation.then(settle, settle);
    const end = () => {
      animation.stop();
      settle();
    };
    return { cancel: end, stop: end };
  } catch {
    settle();
    return null;
  }
}

/**
 * 這一刻是否有 View Transition 在進行（react-router 的 viewTransition 換頁、側欄收合）：那時換頁的進場由
 * ::view-transition-new 負責，這裡不再疊一層 WAAPI。不支援 :active-view-transition 的瀏覽器回 false。
 */
export function viewTransitionActive(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.documentElement.matches(":active-view-transition");
  } catch {
    return false;
  }
}

interface TypedViewTransitionDocument {
  startViewTransition?: (options: { update: () => void; types: string[] }) => unknown;
}

/** 瀏覽器支援帶 types 的 View Transition（Chrome 125+）；舊版只接受 callback，傳物件會出錯，所以先偵測。 */
function supportsTypedViewTransition(): boolean {
  if (typeof document === "undefined" || typeof (document as TypedViewTransitionDocument).startViewTransition !== "function") return false;
  const ctor = (globalThis as { ViewTransition?: { prototype: object } }).ViewTransition;
  return ctor !== undefined && "types" in ctor.prototype;
}

/**
 * 以 View Transition 包住一個同步的狀態更新（例如側欄收合：:active-view-transition-type(sidebar) 的樣式負責變形）。
 * 狀態在 callback 內以 flushSync 立即提交，不等動畫；不支援或過程出錯時直接更新。
 */
export function runViewTransition(type: string, update: () => void): void {
  if (!supportsTypedViewTransition()) {
    update();
    return;
  }
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- The native view transition takes its new-layout snapshot when this callback returns.
    flushSync(update);
  };
  try {
    (document as TypedViewTransitionDocument).startViewTransition?.({ update: apply, types: [type] });
  } catch {
    apply();
  }
}

/** 換頁（路由、工作區、讀取完成的內容）：淡入＋由下往上 8 px＋0.985→1（smooth 彈簧）。View Transition 進行中時不播放。 */
export function playPageEnter(element: Element | null | undefined): void {
  if (viewTransitionActive()) return;
  playMotion(
    element,
    [
      { opacity: 0, transform: `translateY(${String(motionShift("panel"))}px) scale(0.985)` },
      { opacity: 1, transform: "translateY(0px) scale(1)" },
    ],
    { duration: "spring-smooth", easing: "spring-smooth" },
  );
}

/** 同一位置的內容換成另一份（分頁內容、狀態文字）：短淡入，不位移。 */
export function playSwap(element: Element | null | undefined): void {
  playMotion(element, [{ opacity: 0 }, { opacity: 1 }], { duration: "fast", easing: "standard" });
}

// ---------------------------------------------------------------------------------------------------------------
// 分頁指示線：tablist 內一條 2 px 的線，依目前分頁的位置與寬度以 transform 平滑移動。

/** 目前分頁：ARIA tabs 的選取分頁，或以 aria-current 標示的導覽連結。 */
export const ACTIVE_TAB_SELECTOR = '[role="tab"][aria-selected="true"], [aria-current="page"]';

/** 元件相對於 container 的位置（沿 offsetParent 鏈；container 必須是 positioned）；不在鏈上時回 null。 */
function offsetWithin(element: HTMLElement, container: HTMLElement, axis: IndicatorAxis): number | null {
  let offset = 0;
  let node: HTMLElement = element;
  for (;;) {
    offset += axis === "x" ? node.offsetLeft : node.offsetTop;
    const parent = node.offsetParent;
    if (parent === container) return offset;
    if (!(parent instanceof HTMLElement) || !container.contains(parent)) return null;
    node = parent;
  }
}

function rectOffset(element: HTMLElement, container: HTMLElement, axis: IndicatorAxis): number {
  const box = element.getBoundingClientRect();
  const frame = container.getBoundingClientRect();
  return axis === "x" ? box.left - frame.left - container.clientLeft + container.scrollLeft : box.top - frame.top - container.clientTop + container.scrollTop;
}

export interface IndicatorOptions {
  axis?: IndicatorAxis;
  /** 指示線兩端各內縮的 px（例如只畫在圖示＋文字下方）。 */
  inset?: number;
  /** 找目前分頁的 selector（預設 ACTIVE_TAB_SELECTOR）。 */
  selector?: string;
  /** 目前分頁換了時，讓它 aria-controls 指向的 tabpanel 短暫淡入（路由連結沒有 aria-controls，不受影響）。 */
  swapPanels?: boolean;
}

interface IndicatorState {
  observer: ResizeObserver | null;
  observed: WeakSet<Element>;
  transform: string;
  activeId: string | null;
}

/**
 * 把 indicator 放到 container 內目前分頁的位置。每次 render 後量一次（標籤、計數、選取都會改變幾何），
 * 另以 ResizeObserver 補上不經 render 的尺寸變化（字型載入、視窗縮放）。第一次出現時直接就位、不從 0 滑入。
 */
function observe(current: IndicatorState, container: HTMLElement | null, indicator: HTMLElement | null, place: RefObject<() => void>): void {
  if (!container || typeof ResizeObserver === "undefined") return;
  current.observer ??= new ResizeObserver(() => { place.current(); });
  for (const element of [container, ...Array.from(container.children)]) {
    if (current.observed.has(element) || element === indicator) continue;
    current.observed.add(element);
    current.observer.observe(element);
  }
}

export function useActiveIndicator(containerRef: RefObject<HTMLElement | null>, indicatorRef: RefObject<HTMLElement | null>, options: IndicatorOptions = {}): void {
  const { axis = "x", inset = 0, selector = ACTIVE_TAB_SELECTOR, swapPanels = true } = options;
  const stateRef = useRef<IndicatorState>({ observer: null, observed: new WeakSet(), transform: "", activeId: null });
  const placeRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const current = stateRef.current;
    placeRef.current = () => {
      const container = containerRef.current;
      const indicator = indicatorRef.current;
      if (!container || !indicator) return;
      const active = container.querySelector<HTMLElement>(selector);
      if (!active) {
        indicator.dataset["state"] = "hidden";
        current.activeId = null;
        return;
      }
      const activeId = nonEmptyText(active.id) ?? nonEmptyText(active.getAttribute("aria-controls")) ?? active.getAttribute("href");
      if (swapPanels && current.activeId !== null && activeId !== current.activeId) {
        const panelId = active.getAttribute("aria-controls");
        playSwap((panelId != null && panelId !== "") ? document.getElementById(panelId) : null);
      }
      current.activeId = activeId;
      const start = offsetWithin(active, container, axis) ?? rectOffset(active, container, axis);
      const size = axis === "x" ? active.offsetWidth : active.offsetHeight;
      const transform = indicatorTransform(axis, indicatorPlacement({ start, size }, inset));
      const visible = indicator.dataset["state"] === "visible";
      if (visible && transform === current.transform) return;
      current.transform = transform;
      if (visible) {
        indicator.style.transform = transform;
        return;
      }
      // 第一次（或從隱藏恢復）：先無過場地放到位置，再打開過場，之後的切換才會滑動
      indicator.style.transition = "none";
      indicator.style.transform = transform;
      indicator.getBoundingClientRect();
      indicator.style.removeProperty("transition");
      indicator.dataset["state"] = "visible";
    };
    placeRef.current();
    observe(current, containerRef.current, indicatorRef.current, placeRef);
  });

  // 容器的 ref 若掛在父層元素（例如 AppShell 的 <nav>），首次掛載時子元件的 layout effect 先於父層 ref 執行，
  // 上面會找不到容器；passive effect 時所有 ref 都已就緒，這裡補一次定位與監看（place 是冪等的）。
  useEffect(() => {
    placeRef.current();
    observe(stateRef.current, containerRef.current, indicatorRef.current, placeRef);
  });

  useEffect(() => {
    const current = stateRef.current;
    return () => {
      current.observer?.disconnect();
      current.observer = null;
      current.observed = new WeakSet();
    };
  }, []);
}

// ---------------------------------------------------------------------------------------------------------------
// 換頁淡入：container 的第一個子元素被換掉（換路由、換工作區、Suspense 讀完頁面、讀取中→內容）時淡入新內容；
// 同一份內容就地更新（輪詢、選取、輸入）不播放。只看 DOM（MutationObserver），不改 React 樹、不重新掛載頁面。

export function useContentSwapMotion<T extends HTMLElement>(): RefCallback<T> {
  return useCallback((container: T | null) => {
    if (!container || typeof MutationObserver === "undefined") return;
    let root = container.firstElementChild;
    const observer = new MutationObserver(() => {
      const next = container.firstElementChild;
      if (next === root) return;
      const previous = root;
      root = next;
      if (previous && next) playPageEnter(next);
    });
    observer.observe(container, { childList: true });
    return () => { observer.disconnect(); };
  }, []);
}

// ---------------------------------------------------------------------------------------------------------------
// 值改變時短暫淡入（狀態 chip「載入中→就緒」、儲存狀態）：第一次掛載不播放，只在之後的改變播放。

export function useChangeFade<T extends Element>(value: unknown): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const previousRef = useRef(value);
  useLayoutEffect(() => {
    if (Object.is(previousRef.current, value)) return;
    previousRef.current = value;
    playSwap(ref.current);
  }, [value]);
  return ref;
}

// ---------------------------------------------------------------------------------------------------------------
// 面板開合：按下收合／展開的處理器先記下面板的 key，接著掛上的那個元素（面板本體或收合後的窄軌）從所在邊緣
// 淡入＋滑入 16 px（smooth 彈簧）。寬度本身立即改變（不逐格重排），只有內容做 transform／opacity；第一次載入頁面時不播放。
// 焦點：按下的收合／展開按鈕會跟著舊的一側消失；若焦點原本就在那顆按鈕上，改交給新出現那一側的對應按鈕，
// 不讓焦點掉到 body（與動畫無關、也不等動畫）。

/** 收合／展開控制項一律標 data-panel-toggle（不依 aria-label 文字判斷：介面翻譯後文字會變）。 */
const TOGGLE_CONTROL = "[data-panel-toggle]";

interface PendingToggle {
  at: number;
  refocus: boolean;
}

const pendingToggles = new Map<string, PendingToggle>();
const TOGGLE_WINDOW_MS = 800;

/**
 * 在收合／展開按鈕的事件處理器呼叫（不要在 render 中呼叫）。refocus 預設＝焦點正在收合／展開按鈕上；
 * 觸發的按鈕本身不會消失時（例如 dock 標題列的開合鈕）傳 false。
 */
export function notePanelToggle(key: string, options: { refocus?: boolean } = {}): void {
  const active = document.activeElement;
  const refocus = options.refocus ?? (active instanceof HTMLElement && active.matches(TOGGLE_CONTROL));
  pendingToggles.set(key, { at: performance.now(), refocus });
}

function takePanelToggle(key: string): PendingToggle | null {
  const toggle = pendingToggles.get(key);
  pendingToggles.delete(key);
  return toggle && performance.now() - toggle.at < TOGGLE_WINDOW_MS ? toggle : null;
}

function focusToggleControl(root: Element): void {
  const target = root.querySelector<HTMLElement>(TOGGLE_CONTROL);
  target?.focus({ preventScroll: true });
}

export type PanelEdge = "left" | "right" | "bottom" | "none";

/** 側邊面板（Inspector、資源樹）從邊緣滑入 2× panel 位移（16 px）；底部面板 8 px。 */
function panelOffset(edge: PanelEdge): string {
  const shift = motionShift("panel");
  if (edge === "left") return `translateX(${String(-shift * 2)}px)`;
  if (edge === "right") return `translateX(${String(shift * 2)}px)`;
  if (edge === "bottom") return `translateY(${String(shift)}px)`;
  return "none";
}

/** 面板（或窄軌）的 ref：若它是因為 notePanelToggle(key) 而掛上，從 edge 那一側滑入，必要時接手焦點。 */
export function usePanelEnter<T extends Element>(key: string, edge: PanelEdge): RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      if (!node) return;
      const toggle = takePanelToggle(key);
      if (!toggle) return;
      if (toggle.refocus) focusToggleControl(node);
      playMotion(node, [{ opacity: 0, transform: panelOffset(edge) }, { opacity: 1, transform: "none" }], { duration: "spring-smooth", easing: "spring-smooth" });
    },
    [key, edge],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 清單補位（FLIP）：項目增減或換序後，其他項目從舊位置以 snappy 彈簧滑到新位置（只用 transform，Motion 播放）。
// 量測用 offsetTop（版面位置，不含捲動與進行中的 transform），所以滑行途中再換序時從目前的位置接手，不會跳。
// version 改變時才量測（輪詢沒有改變順序就不動）。

export function useFlipList(containerRef: RefObject<HTMLElement | null>, version: unknown): void {
  const positionsRef = useRef(new Map<Element, number>());
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const next = new Map<Element, number>();
    for (const child of Array.from(container.children)) if (child instanceof HTMLElement) next.set(child, child.offsetTop);
    for (const [child, top] of next) {
      const before = positionsRef.current.get(child);
      if (before === undefined || Math.abs(before - top) < 0.5 || !(child instanceof HTMLElement)) continue;
      const current = new DOMMatrixReadOnly(getComputedStyle(child).transform === "none" ? undefined : getComputedStyle(child).transform).m42;
      playMotion(child, [{ transform: `translateY(${String(before - top + current)}px)` }, { transform: "translateY(0px)" }], { duration: "spring-snappy", easing: "spring-snappy" });
    }
    positionsRef.current = next;
  }, [containerRef, version]);
}

// ---------------------------------------------------------------------------------------------------------------
// 清單逐項進場（Motion）：第一次出現的項目淡入、上移 8 px、0.985→1（smooth 彈簧），依序延遲 index × 24 ms（最多第 10 項）。
// 用法：項目加 ref={reveal(index)}。ref 依 index 共用同一個函式，重新 render 不會重播；只有新掛上的元素播放
// （輪詢、選取、輸入不重播；key 不變的項目一直掛著）。起點在 commit 時就套上，所以延遲期間不會先閃出來。

const revealRefs = new Map<number, RefCallback<HTMLElement | SVGElement>>();

export function reveal(index: number): RefCallback<HTMLElement | SVGElement> {
  const step = Math.min(Math.max(0, Math.trunc(index)), STAGGER_LIMIT);
  let ref = revealRefs.get(step);
  if (!ref) {
    ref = (node) => {
      if (!node) return;
      const opacity = node.style.getPropertyValue("opacity");
      node.style.opacity = "0";
      const handle = playMotion(
        node,
        [
          { opacity: 0, transform: `translateY(${String(motionShift("panel"))}px) scale(0.985)` },
          { opacity: 1, transform: "translateY(0px) scale(1)" },
        ],
        { duration: "spring-smooth", easing: "spring-smooth", delayMs: step * STAGGER_STEP_MS },
        { opacity },
      );
      return () => handle?.stop();
    };
    revealRefs.set(step, ref);
  }
  return ref;
}
