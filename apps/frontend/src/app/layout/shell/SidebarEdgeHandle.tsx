import type { Ref } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/**
 * 全收側欄的左緣把手（只在寬螢幕）：整條左緣是 6 px 的感應區，中間一段細細的品牌漸層把手。指標停在這裡時把手
 * 在 1 秒內由下往上填滿（與滑出的等待時間相同），填滿就滑出；直接點把手立即滑出。鍵盤：Tab 到把手按 Enter／空白鍵
 * 滑出並把焦點移進側欄（Tab 進側欄本身也會滑出）；Esc 收回後焦點回到這裡。
 */
export function SidebarEdgeHandle({
  ref,
  revealed,
  onReveal,
  onPointerEnter,
  onPointerLeave,
}: {
  ref: Ref<HTMLButtonElement>;
  revealed: boolean;
  onReveal: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onReveal}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label={t("顯示側欄")}
      aria-controls="shell-sidebar"
      aria-expanded={revealed}
      title={t("顯示側欄（指標停在螢幕左緣 1 秒後滑出）")}
      className="group/edge fixed inset-y-0 left-0 z-40 w-1.5 cursor-e-resize outline-none max-md:hidden"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 left-0.5 h-14 w-1 -translate-y-1/2 overflow-hidden rounded-full bg-line-strong/60 transition-[opacity,background-color] duration-(--duration-fast)",
          "group-hover/edge:bg-line-strong group-focus-visible/edge:outline-2 group-focus-visible/edge:outline-offset-2 group-focus-visible/edge:outline-focus",
          revealed ? "opacity-0" : "opacity-100",
        )}
      >
        {/* 停留進度：滑過時 1 秒內填滿，離開時立即歸零 */}
        <span className="absolute inset-0 origin-bottom scale-y-0 bg-brand-gradient transition-transform duration-0 ease-linear group-hover/edge:scale-y-100 group-hover/edge:duration-1000" />
      </span>
    </button>
  );
}
