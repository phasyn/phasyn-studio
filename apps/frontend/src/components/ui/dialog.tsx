// SPDX-License-Identifier: Apache-2.0 AND MIT
// Portions adapted from shadcn/ui (https://github.com/shadcn-ui/ui, new-york registry: ui/dialog.tsx and ui/sheet.tsx),
// Copyright (c) 2023 shadcn, MIT License; modified by the Phasyn Studio authors (styling, sheet sides, focus return).
// See THIRD_PARTY_NOTICES.md.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { Ref, AnimationEvent, ComponentPropsWithoutRef, ComponentRef, HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { useFocusReturn } from "./focusReturn";

// Radix Dialog：initial focus、focus trap、Escape、關閉後焦點回到觸發元件。
// Portal 掛在 document.body，仍位於 <html data-theme="noir"> 之內，沿用同一組 tokens。
// 外觀（契約 v2：玻璃只用在浮層）：遮罩是深空藍半透明＋6 px 模糊；對話框與側欄單是 material-sheet（88% 不透明＋模糊＋
// 視窗陰影、14 px 圓角）＋頂端一條品牌漸層細線。動作：遮罩淡入、對話框 0.94→1＋上移 12 px（smooth 彈簧）、側欄單由右緣
// 滑入（smooth 彈簧；side="left" 的行動版導覽抽屜由左緣）；出場 140 ms ease-exit。
// 進出場由 data-state 驅動（Radix Presence 等出場動畫結束才卸載）。
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

// 出場中（data-state=closed）不攔截點擊：Radix 在遮罩上寫了 inline pointer-events: auto，所以用 important 蓋過。
const overlayClass =
  "fixed inset-0 z-40 bg-[rgb(2_4_10_/_0.66)] backdrop-blur-[6px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out data-[state=closed]:pointer-events-none!";

/** 浮層頂端的品牌漸層細線（裝飾）。 */
const brandHairline = "before:pointer-events-none before:absolute before:inset-x-8 before:top-0 before:h-px before:bg-brand-gradient before:opacity-70";

type ContentProps = ComponentPropsWithoutRef<typeof DialogPrimitive.Content>;

/**
 * Radix Presence keeps closed content mounted until its exit animation ends. From the start of that animation the
 * content is inert, so keyboard focus and typing leave it at once instead of reaching a dialog that is going away (the
 * pointer is already blocked by pointer-events); reopening during the exit plays the entrance and lifts it again.
 */
function inertWhileClosing(onAnimationStart: ContentProps["onAnimationStart"]) {
  return (event: AnimationEvent<HTMLDivElement>) => {
    onAnimationStart?.(event);
    if (event.target === event.currentTarget) event.currentTarget.inert = event.currentTarget.dataset["state"] === "closed";
  };
}

export function DialogContent(
  { ref, className, children, wide = false, closeDisabled = false, onOpenAutoFocus, onCloseAutoFocus, onAnimationStart, ...props }: ContentProps & { wide?: boolean; /** Greys out the corner X while the dialog must stay open (e.g. a removal in progress). */ closeDisabled?: boolean } & { ref?: Ref<ComponentRef<typeof DialogPrimitive.Content>> | undefined },
) {
  const focus = useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "material-sheet fixed top-1/2 left-1/2 z-50 flex max-h-[min(88vh,52rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[rgb(255_255_255_/_0.08)] text-fg",
          brandHairline,
          "data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out data-[state=closed]:pointer-events-none!",
          wide ? "max-w-4xl" : "max-w-lg",
          className,
        )}
        {...props}
        {...focus}
        onAnimationStart={inertWhileClosing(onAnimationStart)}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-3 right-3 inline-flex size-10 items-center justify-center rounded-md text-fg-secondary pressable hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          aria-label={t("關閉")}
          disabled={closeDisabled}
        >
          <X aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetContent(
  { ref, className, children, onOpenAutoFocus, onCloseAutoFocus, onAnimationStart, side = "right", closeLabel: closeLabelProp, ...props }: ContentProps & { side?: "right" | "left"; closeLabel?: string } & { ref?: Ref<ComponentRef<typeof DialogPrimitive.Content>> | undefined },
) {
  const closeLabel = closeLabelProp ?? t("關閉詳情");
  const focus = useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "material-sheet fixed inset-y-0 z-50 flex w-[min(24rem,92vw)] flex-col text-fg",
          brandHairline,
          side === "left"
            ? "left-0 border-r border-[rgb(255_255_255_/_0.08)] data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out"
            : "right-0 border-l border-[rgb(255_255_255_/_0.08)] data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out",
          "data-[state=closed]:pointer-events-none!",
          className,
        )}
        {...props}
        {...focus}
        onAnimationStart={inertWhileClosing(onAnimationStart)}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-2 right-2 inline-flex size-10 items-center justify-center rounded-md text-fg-secondary pressable hover:bg-raised hover:text-fg"
          aria-label={closeLabel}
        >
          <X aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 border-b border-line-subtle px-6 pt-5 pb-4 pr-14", className)} {...props} />;
}

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 border-t border-line-subtle px-6 py-4", className)}
      {...props}
    />
  );
}

export function DialogTitle(
  { ref, className, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & { ref?: Ref<ComponentRef<typeof DialogPrimitive.Title>> | undefined },
) {
  return <DialogPrimitive.Title ref={ref} className={cn("text-section font-semibold text-fg", className)} {...props} />;
}

export function DialogDescription(
  { ref, className, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & { ref?: Ref<ComponentRef<typeof DialogPrimitive.Description>> | undefined },
) {
  return <DialogPrimitive.Description ref={ref} className={cn("text-data text-fg-secondary", className)} {...props} />;
}
