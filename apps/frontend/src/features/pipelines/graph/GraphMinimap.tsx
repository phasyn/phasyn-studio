// 小地圖：節點方塊＋目前畫面框；點選移動畫面。只在內容超出畫面時顯示。
// 純指標輔助（aria-hidden）：鍵盤有方向鍵、符合視窗（F）等同等功能。
import type { PointerEvent } from "react";
import { cn } from "@/lib/cn";
import type { GraphLayout } from "./graphTypes";
import { visibleContentRect, type Size, type ViewTransform } from "./graphView";
import { t } from "@/i18n";

const MAX_W = 168;
const MAX_H = 104;

export function GraphMinimap({
  layout,
  view,
  viewport,
  selectedKey,
  onCenter,
}: {
  layout: GraphLayout;
  view: ViewTransform;
  viewport: Size;
  selectedKey: string | null;
  onCenter: (point: { x: number; y: number }) => void;
}) {
  const scale = Math.min(MAX_W / Math.max(1, layout.width), MAX_H / Math.max(1, layout.height));
  const width = Math.max(24, Math.round(layout.width * scale));
  const height = Math.max(16, Math.round(layout.height * scale));
  const visible = visibleContentRect(view, viewport);
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onCenter({ x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale });
  };
  return (
    <div
      aria-hidden
      data-graph-tool=""
      className="material-hud absolute right-2 bottom-2 z-10 rounded-lg border border-line-subtle/70 p-1 shadow-edge animate-fade-in"
      title={t("小地圖：點選以移動畫面")}
    >
      <svg width={width} height={height} className="block cursor-pointer" onPointerDown={onPointerDown}>
        {[...layout.boxes.values()].map((box) => (
          <rect
            key={box.key}
            x={box.x * scale}
            y={box.y * scale}
            width={Math.max(2, box.width * scale)}
            height={Math.max(2, box.height * scale)}
            rx={1.5}
            className={cn("transition-[fill] duration-(--duration-fast)", box.key === selectedKey ? "fill-brand-cyan" : "fill-line-strong")}
          />
        ))}
        {/* 目前畫面框：品牌藍細框＋極淡的底色（只標位置，不遮住節點）。 */}
        <rect
          x={visible.x * scale}
          y={visible.y * scale}
          width={visible.width * scale}
          height={visible.height * scale}
          rx={2}
          strokeWidth={1}
          className="fill-brand-blue/10 stroke-brand-blue"
        />
      </svg>
    </div>
  );
}
