// The picture area of a monitor: a black stage that letterboxes the sequence's aspect ratio. "fit" fills the panel
// (object-fit contain); a percentage shows the output at that scale and scrolls when it is larger than the panel.
import { useRef, type DragEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useElementSize } from "@/lib/useElementSize";

export type ViewerZoom = "fit" | number;

const MARGIN = 8;

export function ViewerFrame({
  width,
  height,
  zoom = "fit",
  title,
  className,
  overlay,
  drag,
  children,
}: {
  /** Output size in pixels (the aspect ratio of the picture; the size at 100 %). */
  width: number;
  height: number;
  zoom?: ViewerZoom;
  title?: string;
  className?: string;
  /** Drawn over the picture without being clipped to it (handles that sit on the picture's edge). */
  overlay?: ReactNode;
  /** Makes the picture a drag source (the Source monitor: its picture is dragged to the timeline). */
  drag?: { title: string; onStart: (event: DragEvent<HTMLDivElement>) => void; onEnd: () => void };
  children: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const room = useElementSize(stageRef);
  // Fit leaves a small margin, so handles on the picture's edge stay inside the stage
  const fitted = Math.min((room.width - 2 * MARGIN) / Math.max(1, width), (room.height - 2 * MARGIN) / Math.max(1, height));
  const scale = zoom === "fit" ? fitted : zoom / 100;
  const box = { width: Math.max(0, Math.floor(width * scale)), height: Math.max(0, Math.floor(height * scale)) };
  const overflows = box.width > room.width || box.height > room.height;
  return (
    <div ref={stageRef} title={title} className={cn("relative min-h-0 min-w-0 flex-1 bg-stage", overflows ? "overflow-auto" : "overflow-hidden", className)}>
      <div className={cn("grid min-h-full min-w-full", !overflows && "place-items-center")}>
        <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Dragging the source monitor is an optional gesture; the source monitor also has an insert command. */
          className={cn("relative shrink-0", drag && "cursor-grab active:cursor-grabbing")}
          style={box}
          draggable={drag ? true : undefined}
          title={drag?.title}
          onDragStart={drag?.onStart}
          onDragEnd={drag?.onEnd}
        >
          <div className="absolute inset-0 overflow-hidden bg-stage">{box.width > 0 ? children : null}</div>
          {box.width > 0 ? overlay : null}
        </div>
      </div>
    </div>
  );
}
