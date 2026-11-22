import { useEffect, useRef, useState } from "react";
import type { StudioPrevis, StudioPrevisPose } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { drag3D } from "./spaceModel";
import type { PrevisPainter } from "./spacePainter";
import { movedPose, writeKey } from "./composition";

interface Props {
  painter: PrevisPainter;
  scene: StudioPrevis;
  frame: number;
  width: number;
  height: number;
  images: Map<string, HTMLImageElement>;
  depth: boolean;
  problem: string | null;
  layerIndex: number;
  canKey: boolean;
  onMove: (pose: StudioPrevisPose) => void;
}
export function PrevisCanvas({ painter, scene, frame, width, height, images, depth, layerIndex, problem, canKey, onMove }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<StudioPrevisPose | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const target = canvasRef.current;
    if (!target) return;
    // Paint on the presentation clock. Superseded edits cancel the pending draw.
    const id = requestAnimationFrame(() => {
      if ((problem != null && problem !== "")) {
        target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
        return;
      }
      try {
        const composed = drag
          ? { ...scene, layers: scene.layers.map((layer, i) => (i === layerIndex ? { ...layer, keys: writeKey(layer.keys, drag) } : layer)) }
          : scene;
        painter.draw(target, composed, frame, images, depth);
        setError(null);
      } catch (cause) {
        setError(errorText(cause));
      }
    });
    return () => { cancelAnimationFrame(id); };
  }, [painter, scene, frame, images, depth, problem, layerIndex, drag, width, height]);
  const dragTo = (dx: number, dy: number) =>
    scene.projection === "stage3d" ? drag3D(scene, frame, layerIndex, width / height, dx, dy) : movedPose(scene, frame, layerIndex, dx, dy);
  const ratio = Math.min(1, 1000 / width, 650 / height);
  return (
    <div className="grid gap-2">
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.round(width * ratio))}
        height={Math.max(1, Math.round(height * ratio))}
        aria-label={t("預演畫面")}
        className="m-auto block h-auto max-h-96 max-w-full touch-none rounded-md border border-line-subtle bg-stage"
        onPointerDown={(e) => {
          if (layerIndex < 0 || (error != null && error !== "") || (problem != null && problem !== "") || !canKey || e.button !== 0) return;
          pointerRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = pointerRef.current;
          if (p?.id !== e.pointerId) return;
          const box = e.currentTarget.getBoundingClientRect();
          setDrag(dragTo((e.clientX - p.x) / box.width, (e.clientY - p.y) / box.height));
        }}
        onPointerUp={(e) => {
          const p = pointerRef.current;
          if (p?.id !== e.pointerId) return;
          pointerRef.current = null;
          const box = e.currentTarget.getBoundingClientRect();
          const pose = dragTo((e.clientX - p.x) / box.width, (e.clientY - p.y) / box.height);
          setDrag(null);
          if (pose && (p.x !== e.clientX || p.y !== e.clientY)) onMove(pose);
        }}
        onLostPointerCapture={() => {
          pointerRef.current = null;
          setDrag(null);
        }}
      />
      {(problem != null && problem !== "") || (error != null && error !== "") ? (
        <p role="status" className="text-warning">
          {problem ?? error}
        </p>
      ) : null}
    </div>
  );
}
