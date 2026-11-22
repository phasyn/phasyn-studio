// 動作選單（WAI-ARIA menu／menu button）：↑↓ 移動（循環）、Home／End 到頭尾、Enter／Space 執行、Esc 關閉並把焦點
// 還給觸發元件、Tab 關閉後照常移動焦點；點選單外、捲動或縮放視窗時關閉。不用 portal：以 position: fixed
// 留在原本的 React 樹內（不被面板的 overflow 裁掉，也留在對話框的焦點範圍內）。祖先若會成為 fixed 的定位基準
// （有 transform、filter 或 container query 的元素，例如對話框），座標改以它為準（fixedFrame）。
// 停用的選項仍可聚焦，原因寫在選項下方。
// 動作：開啟時從觸發端那一側淡入＋位移 4 px（在錨點下方＝由上落下，翻到上方＝由下升起）；焦點與鍵盤立即可用，
// 不等動畫。關閉立即消失（焦點先回到觸發元件）。
// 外觀（Phasyn／Mac）：半透明浮層材質（material-popover）；目前選項（滑過或鍵盤）是淡品牌漸層底，危險選項是淡紅底。
// 這個元件也給 Image Studio 與元件組合清單使用。
import { Fragment, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { placeMenu, type MenuAnchor, type MenuItem } from "./menuModel";

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
}

const CONTAINS_FIXED = /transform|translate|scale|rotate|perspective|filter/;

/** An element whose box is what `position: fixed` descendants are placed against, instead of the viewport. */
function containsFixed(style: CSSStyleDeclaration): boolean {
  const set = (value: string | undefined) => value !== undefined && value !== "" && value !== "none";
  if (set(style.transform) || set(style.translate) || set(style.scale) || set(style.rotate) || set(style.perspective)) return true;
  if (set(style.filter) || set(style.backdropFilter)) return true;
  if (/paint|layout|strict|content/.test(style.contain) || CONTAINS_FIXED.test(style.willChange)) return true;
  return "containerType" in style && style.containerType !== "" && style.containerType !== "normal";
}

/**
 * The box a fixed menu is placed in, in viewport pixels: the viewport, or the padding box of the nearest ancestor
 * that contains fixed descendants (a dialog with a transform or a backdrop filter, a container-query box).
 */
function fixedFrame(menu: HTMLElement): { left: number; top: number; width: number; height: number } {
  for (let node = menu.parentElement; node; node = node.parentElement) {
    if (!containsFixed(getComputedStyle(node))) continue;
    const rect = node.getBoundingClientRect();
    return { left: rect.left + node.clientLeft, top: rect.top + node.clientTop, width: node.clientWidth, height: node.clientHeight };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export function ActionMenu({
  id,
  label,
  items,
  anchor,
  returnFocus,
  initialFocus = "first",
  onClose,
}: {
  id: string;
  /** 選單的無障礙名稱，例如「「海岸公路」的動作」。 */
  label: string;
  items: MenuItem[];
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  initialFocus?: "first" | "last";
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const reasonPrefixId = useId();

  const close = (restoreFocus: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (restoreFocus && (returnFocus?.isConnected === true)) returnFocus.focus();
    onClose();
  };

  const activate = (item: MenuItem) => {
    if (item.disabledReason != null && item.disabledReason !== "") return;
    close(true);
    item.onSelect();
  };

  // 每次 render 後重新定位（選項的停用原因可能隨播放頭改變而改變高度）
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const frame = fixedFrame(menu);
    const seen = anchor.kind === "point" ? { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y } : anchor.element.getBoundingClientRect();
    // The anchor in the coordinates the menu is placed in
    const rect = { left: seen.left - frame.left, top: seen.top - frame.top, right: seen.right - frame.left, bottom: seen.bottom - frame.top };
    const position = placeMenu(rect, { width: menu.offsetWidth, height: menu.offsetHeight }, { width: frame.width, height: frame.height }, anchor.kind === "point" ? 2 : 4);
    menu.style.left = `${String(position.left)}px`;
    menu.style.top = `${String(position.top)}px`;
    // 進場位移的方向：選單在錨點上方時由下升起，否則由上落下（pop-in keyframes 讀這個變數）
    menu.style.setProperty("--motion-pop-y", position.top + 1 < rect.top ? "var(--motion-shift)" : "calc(var(--motion-shift) * -1)");
  });

  // 開啟（或換位置重新開啟）時聚焦第一個／最後一個選項
  useLayoutEffect(() => {
    closingRef.current = false;
    const entries = menuItems(ref.current);
    // preventScroll：選單是 fixed，聚焦不應捲動底下的面板（捲動會關閉選單）
    (initialFocus === "last" ? entries.at(-1) : entries[0])?.focus({ preventScroll: true });
  }, [anchor, initialFocus]);

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || Boolean(ref.current?.contains(target))) return;
    // 再按一次選單按鈕：交給按鈕自己的 click 關閉，避免關了又立刻打開（以 Shift+F10 從片段／鏡頭列開啟時照常關閉）
    if (anchor.kind === "element" && anchor.element.getAttribute("aria-haspopup") === "menu" && anchor.element.contains(target)) return;
    close(false);
  });
  const onOutsideScroll = useEffectEvent((event: Event) => {
    if (event.target instanceof Node && Boolean(ref.current?.contains(event.target))) return;
    close(false);
  });
  const onResize = useEffectEvent(() => { close(false); });

  useEffect(() => {
    const pointer = (event: PointerEvent) => { onOutsidePointer(event); };
    const scroll = (event: Event) => { onOutsideScroll(event); };
    const resize = () => { onResize(); };
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 選單內的按鍵不往外傳：不觸發監看器的空白鍵、I／O 或時間軸快速鍵
    event.stopPropagation();
    const entries = menuItems(ref.current);
    const index = entries.findIndex((entry) => entry === document.activeElement);
    const focusAt = (next: number) => entries[(next + entries.length) % entries.length]?.focus({ preventScroll: true });
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index < 0 ? entries.length - 1 : index - 1);
        break;
      case "Home":
      case "PageUp":
        focusAt(0);
        break;
      case "End":
      case "PageDown":
        focusAt(entries.length - 1);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        // 焦點先回到觸發元件，瀏覽器再照常移到下一個（或上一個）元件
        close(true);
        return;
      case "Enter":
      case " ": {
        const item = index >= 0 ? items[index] : undefined;
        if (item) activate(item);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (next !== null) close(false);
      }}
      onContextMenu={(event) => { event.preventDefault(); }}
      className="material-popover fixed top-0 left-0 z-50 grid max-h-[calc(100vh-1rem)] w-max max-w-80 min-w-56 overflow-y-auto rounded-xl p-1 text-fg outline-none animate-pop-in forced-colors:border forced-colors:border-[CanvasText]"
    >
      {items.map((item) => {
        const reasonId = (item.disabledReason != null && item.disabledReason !== "") ? `${reasonPrefixId}-${item.id}` : undefined;
        const Icon = item.icon;
        return (
          <Fragment key={item.id}>
            {(item.separatorBefore === true) ? <div role="separator" className="mx-2 my-1 h-px bg-white/8" /> : null}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={(item.disabledReason != null && item.disabledReason !== "") ? true : undefined}
              aria-describedby={reasonId}
              onClick={() => { activate(item); }}
              onPointerMove={(event) => {
                if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
              }}
              className={cn(
                "flex min-h-8 w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-data outline-none transition-colors duration-(--duration-fast) [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
                "focus-visible:ring-1 focus-visible:ring-brand-blue/55 focus-visible:ring-inset",
                (item.disabledReason != null && item.disabledReason !== "")
                  ? "cursor-not-allowed text-fg-disabled focus:bg-white/5"
                  : item.tone === "danger"
                    ? "text-danger hover:bg-danger/12 focus:bg-danger/12"
                    : "text-fg hover:bg-brand-gradient-soft focus:bg-brand-gradient-soft [&_svg]:text-fg-secondary focus:[&_svg]:text-brand-cyan",
              )}
            >
              {Icon ? <Icon aria-hidden /> : <span aria-hidden className="size-3.5 shrink-0" />}
              <span className="grid min-w-0 flex-1">
                <span>{item.label}</span>
                {(item.disabledReason != null && item.disabledReason !== "") ? (
                  <span id={reasonId} className="text-caption text-fg-tertiary">
                    {item.disabledReason}
                  </span>
                ) : null}
              </span>
              {(item.shortcut != null && item.shortcut !== "") ? <kbd className="machine ml-3 shrink-0 text-caption text-fg-tertiary">{item.shortcut}</kbd> : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

/** 選單按鈕（menu button）：點擊、Enter、Space 或 ↓ 開啟並聚焦第一個選項，↑ 開啟並聚焦最後一個。 */
export function MenuTriggerButton({
  menuId,
  open,
  label,
  onOpen,
  onClose,
  className,
  children,
}: {
  menuId: string;
  open: boolean;
  label: string;
  onOpen: (element: HTMLButtonElement, focus: "first" | "last") => void;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={label}
      title={label}
      onClick={(event) => { if (open) { onClose(); } else { onOpen(event.currentTarget, "first"); } }}
      onKeyDown={(event) => {
        // 空白鍵／Enter 交給按鈕原生的 click（不讓監看器的全域空白鍵把它當成播放）
        if (event.key === " " || event.key === "Enter") {
          event.stopPropagation();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(event.currentTarget, event.key === "ArrowUp" ? "last" : "first");
      }}
      className={cn(
        "pressable inline-flex shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-fg active:bg-sunken aria-expanded:bg-brand-gradient-soft aria-expanded:text-fg aria-expanded:ring-1 aria-expanded:ring-brand-blue/50 aria-expanded:ring-inset",
        className,
      )}
    >
      {children}
    </button>
  );
}
