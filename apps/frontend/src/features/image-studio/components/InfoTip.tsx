// 欄位的說明提示（ⓘ）：固定的說明收在這裡，不常駐在面板上（說明放提示層，面板只留與狀態有關的提醒）。
// 滑鼠停留 300 ms、用鍵盤聚焦或點一下就出現；移開、失焦、Esc、再點一下、按到別處、捲動或縮放視窗時收起。說明文字一直在
// DOM 裡（aria-describedby），輔助技術聚焦按鈕時就讀得到。浮層掛在 body（不被面板的 overflow 裁掉）、position: fixed，
// 預設在按鈕下方置中，放不下時翻到上方，以 pop-in 從按鈕那一側淡入；它不接收指標（只有文字）。
import { Info } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

const HOVER_DELAY_MS = 300;
const GAP = 6;
const MARGIN = 8;

/** 怎麼打開的：滑鼠停留（移開就收）、鍵盤聚焦（失焦就收）、點一下（再點一下或按到別處才收）。 */
type Opener = "hover" | "focus" | "click";

/** 浮層左上角：按鈕下方置中；下方放不下時翻到上方；左右不超出視窗。 */
function placeTip(anchor: DOMRect, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - size.width);
  const left = Math.min(Math.max(MARGIN, anchor.left + anchor.width / 2 - size.width / 2), maxLeft);
  const below = anchor.bottom + GAP;
  if (below + size.height <= viewport.height - MARGIN) return { left, top: below, above: false };
  return { left, top: Math.max(MARGIN, anchor.top - GAP - size.height), above: true };
}

export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Opener | null>(null);
  const [hovering, setHovering] = useState(false);

  // 滑鼠停留一下才打開（掃過不閃）；已經用別的方式打開時不改
  useEffect(() => {
    if (!hovering) return;
    const timer = window.setTimeout(() => setOpen((current) => current ?? "hover"), HOVER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hovering]);

  useLayoutEffect(() => {
    const node = tip.current;
    const anchor = button.current;
    if (!open || !node || !anchor) return;
    const place = placeTip(anchor.getBoundingClientRect(), { width: node.offsetWidth, height: node.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    node.style.left = `${place.left}px`;
    node.style.top = `${place.top}px`;
    // 進場位移的方向：在按鈕上方時由下升起，否則由上落下（pop-in keyframes 讀這個變數）
    node.style.setProperty("--motion-pop-y", place.above ? "var(--motion-shift)" : "calc(var(--motion-shift) * -1)");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(null);
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && button.current?.contains(event.target)) return;
      setOpen(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={t("{label}：說明", { label })}
        aria-describedby={id}
        data-open={open !== null || undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setHovering(true);
        }}
        onPointerLeave={() => {
          setHovering(false);
          setOpen((current) => (current === "hover" ? null : current));
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen((current) => current ?? "focus");
        }}
        onBlur={() => setOpen(null)}
        onClick={() => setOpen((current) => (current === "click" ? null : "click"))}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.stopPropagation();
          setOpen(null);
        }}
        className={cn(
          "pressable inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-fg active:bg-sunken data-[open]:text-action-fg [&_svg]:size-3.5",
          className,
        )}
      >
        <Info aria-hidden />
      </button>
      <span id={id} hidden>
        {children}
      </span>
      {open
        ? createPortal(
            <div
              ref={tip}
              role="tooltip"
              className="material-popover pointer-events-none fixed top-0 left-0 z-50 w-max max-w-80 rounded-lg px-3 py-2 text-caption leading-5 text-fg-secondary [overflow-wrap:anywhere] animate-pop-in"
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
