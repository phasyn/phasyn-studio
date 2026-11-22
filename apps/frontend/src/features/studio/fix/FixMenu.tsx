// The 修正 menu: every way to fix a take in one place, grouped by task (局部修改, 修復畫質, 動作與補幀, 遮罩與控制,
// 聲音與字幕, 美術往返, 比較) in two columns. Each item is a Chinese name with a one-line description; the pipeline it
// runs is in the item's tooltip only. A WAI-ARIA menu: ↑↓ move (wrapping), ←→ jump between the columns, Home/End,
// Enter/Space pick, Esc or a click outside closes and gives focus back. An unavailable item stays focusable with its
// reason under the description. Rendered in a portal at the anchor (below it, above when there is no room).
import { Fragment, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type MenuAnchor } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { FIX_GROUPS, FIX_TOOLS, type FixGroupId, type FixTool } from "./tools";

const COLUMNS: readonly (readonly FixGroupId[])[] = [
  ["local", "quality", "motion"],
  ["control", "sound", "art", "compare"],
];

export interface FixMenuProps {
  label: string;
  anchor: MenuAnchor;
  /** Why a tool cannot be used now (missing pipeline, no finished video…); absent = usable. */
  reasons: Readonly<Record<string, string | null | undefined>>;
  /** The pipeline each pipeline tool would run (tooltip only). */
  pipelineIds: Readonly<Record<string, string | undefined>>;
  returnFocus: HTMLElement | null;
  onPick: (tool: FixTool) => void;
  onClose: () => void;
}

function entries(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
}

export function FixMenu({ label, anchor, reasons, pipelineIds, returnFocus, onPick, onClose }: FixMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reasonPrefixId = useId();
  const closedRef = useRef(false);

  const close = (restore: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (restore && returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    onClose();
  };
  const pick = (tool: FixTool) => {
    const reason = reasons[tool.id];
    if (reason != null && reason !== "") return;
    close(true);
    onPick(tool);
  };

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = anchor.kind === "point" ? { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y } : anchor.element.getBoundingClientRect();
    const position = placeMenu(rect, { width: menu.offsetWidth, height: menu.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${String(position.left)}px`;
    menu.style.top = `${String(position.top)}px`;
    menu.style.setProperty("--motion-pop-y", position.top + 1 < rect.top ? "var(--motion-shift)" : "calc(var(--motion-shift) * -1)");
  });

  useLayoutEffect(() => {
    closedRef.current = false;
    const items = entries(ref.current);
    (items.find((item) => item.getAttribute("aria-disabled") !== "true") ?? items[0])?.focus({ preventScroll: true });
  }, [anchor]);

  const onOutside = useEffectEvent((event: Event) => {
    const target = event.target;
    if (target instanceof Node && ref.current?.contains(target) === true) return;
    // The menu button closes the menu itself (a second click must not reopen it)
    if (event.type === "pointerdown" && anchor.kind === "element" && target instanceof Node && anchor.element.contains(target)) return;
    close(false);
  });
  useEffect(() => {
    const handler = (event: Event) => { onOutside(event); };
    document.addEventListener("pointerdown", handler, true);
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      document.removeEventListener("pointerdown", handler, true);
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const items = entries(ref.current);
    const index = items.findIndex((item) => item === document.activeElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus({ preventScroll: true });
    const column = (direction: number) => {
      const current = items[index];
      const at = Number(current?.dataset["column"] ?? 0);
      const target = items.find((item) => Number(item.dataset["column"]) === at + direction);
      target?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index < 0 ? items.length - 1 : index - 1);
        break;
      case "ArrowRight":
        column(1);
        break;
      case "ArrowLeft":
        column(-1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        close(true);
        return;
      case "Enter":
      case " ": {
        const id = items[index]?.dataset["tool"];
        const tool = FIX_TOOLS.find((item) => item.id === id);
        if (tool) pick(tool);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (next !== null) close(false);
      }}
      className="material-popover fixed top-0 left-0 z-50 grid max-h-[calc(100vh-1rem)] w-[min(40rem,calc(100vw-1rem))] grid-cols-1 gap-x-1 overflow-y-auto rounded-xl p-1.5 text-fg outline-none animate-pop-in sm:grid-cols-2"
    >
      {COLUMNS.map((groups, column) => (
        <div key={groups.join()} className="grid content-start gap-1">
          {groups.map((groupId) => {
            const group = FIX_GROUPS.find((item) => item.id === groupId);
            const tools = FIX_TOOLS.filter((tool) => tool.group === groupId);
            if (!group || tools.length === 0) return null;
            return (
              <div key={groupId} role="group" aria-label={group.label()} className="grid">
                <p aria-hidden className="px-2 pt-1.5 pb-0.5 text-caption font-semibold text-fg-tertiary">{group.label()}</p>
                {tools.map((tool) => {
                  const reason = reasons[tool.id];
                  const blocked = reason != null && reason !== "";
                  const reasonId = blocked ? `${reasonPrefixId}-${tool.id}` : undefined;
                  const pipeline = pipelineIds[tool.id];
                  const Icon = tool.icon;
                  return (
                    <Fragment key={tool.id}>
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        data-tool={tool.id}
                        data-column={column}
                        aria-disabled={blocked ? true : undefined}
                        aria-describedby={reasonId}
                        title={pipeline === undefined ? undefined : t("流程：{id}", { id: pipeline })}
                        onClick={() => { pick(tool); }}
                        onPointerMove={(event) => {
                          if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
                        }}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors duration-(--duration-fast)",
                          "focus-visible:ring-1 focus-visible:ring-brand-blue/55 focus-visible:ring-inset",
                          blocked ? "cursor-not-allowed focus:bg-white/5" : "hover:bg-brand-gradient-soft focus:bg-brand-gradient-soft",
                        )}
                      >
                        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", blocked ? "text-fg-disabled" : "text-fg-secondary")} />
                        <span className="grid min-w-0 flex-1">
                          <span className={cn("text-data font-medium", blocked ? "text-fg-disabled" : "text-fg")}>{tool.name()}</span>
                          <span className="text-caption text-fg-tertiary">{tool.description()}</span>
                          {blocked ? <span id={reasonId} className="text-caption text-warning/80">{reason}</span> : null}
                        </span>
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>,
    document.body,
  );
}
