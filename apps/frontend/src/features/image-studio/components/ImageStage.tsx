import { hasSlotContent } from "@/lib/dom";
// 監看器的圖片舞台：一張圖（符合視窗或 1:1；換圖時新的圖片讀完才淡入，讀不到時說明原因）與分隔疊圖比較（拖曳或用滑桿／
// 方向鍵移動分隔線）。浮在圖上的標籤用 HUD 材質（只在媒體上方使用）。
import { ArrowLeftRight } from "lucide-react";
import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { HUD_CHIP } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { useElementSize } from "@/lib/useElementSize";
import type { ImageAsset } from "../types";
import { BACKDROP_CLASS, fileUrl, type Backdrop } from "./display";
import { t } from "@/i18n";

export type Zoom = "fit" | "actual";

/**
 * 一張圖的舞台（符合視窗或 1:1）。換圖時新的圖片讀完才淡入（opacity），讀不到時說明原因。
 * 浮在圖上的標籤用 HUD 材質（只在媒體上方使用）。
 */
export function ImageStage({ asset, alt, backdrop, zoom, label, className }: { asset: ImageAsset; alt: string; backdrop: Backdrop; zoom: Zoom; label?: ReactNode; className?: string }) {
  const url = fileUrl(asset.file);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <div className={cn("relative size-full min-h-0", zoom === "actual" ? "overflow-auto" : "grid place-items-center overflow-hidden", BACKDROP_CLASS[backdrop], className)}>
      {(url != null && url !== "") && failed !== url ? (
        <img
          key={url}
          src={url}
          alt={alt}
          draggable={false}
          onLoad={() => { setLoaded(url); }}
          onError={() => { setFailed(url); }}
          data-loaded={loaded === url || undefined}
          className={cn("opacity-0 transition-opacity duration-(--duration-base) ease-standard data-[loaded]:opacity-100", zoom === "fit" ? "absolute inset-0 size-full object-contain" : "max-w-none")}
          style={zoom === "actual" ? { width: asset.width || undefined, height: asset.height || undefined } : undefined}
        />
      ) : (
        <EmptyState illustration="offline" size="compact" title={t("圖片讀不到")} description={t("檔案可能已刪除，或存放它的 Node 離線。")} />
      )}
      {hasSlotContent(label) ? <span className={cn(HUD_CHIP, "pointer-events-none absolute top-2.5 left-2.5 max-w-[calc(100%-1.25rem)] truncate")}>{label}</span> : null}
    </div>
  );
}

/** 在容器內以原比例最大化（contain）的尺寸；容器還沒量到時 null。 */
function containSize(container: { width: number; height: number }, width: number, height: number): { width: number; height: number } | null {
  if (container.width <= 0 || container.height <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.min(container.width / width, container.height / height);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

export function Wipe({ a, b, labelA, labelB, backdrop }: { a: ImageAsset; b: ImageAsset; labelA: string; labelB: string; backdrop: Backdrop }) {
  const id = useId();
  const [split, setSplit] = useState(50);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const box = containSize(useElementSize(stageRef), a.width || 1, a.height || 1);
  const dragRef = useRef<number | null>(null);
  const urlA = fileUrl(a.file);
  const urlB = fileUrl(b.file);
  const move = (clientX: number) => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    setSplit(Math.round(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100))));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 指標已放開
    }
    move(event.clientX);
  };
  return (
    <div className="grid size-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2 p-2">
      <div ref={stageRef} className={cn("grid min-h-0 place-items-center overflow-hidden", BACKDROP_CLASS[backdrop])}>
        <div
          ref={frameRef}
          className="relative cursor-ew-resize touch-none select-none"
          style={box ? { width: box.width, height: box.height } : { width: "100%", height: "100%" }}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => {
            if (dragRef.current === event.pointerId) move(event.clientX);
          }}
          onPointerUp={(event) => {
            if (dragRef.current === event.pointerId) dragRef.current = null;
          }}
          onPointerCancel={() => (void (dragRef.current = null))}
        >
          {(urlA != null && urlA !== "") ? <img src={urlA} alt={t("A：{labelA}", { labelA })} draggable={false} className="absolute inset-0 size-full object-contain" /> : null}
          {(urlB != null && urlB !== "") ? <img src={urlB} alt={t("B：{labelB}", { labelB })} draggable={false} className="absolute inset-0 size-full object-contain" style={{ clipPath: `inset(0 0 0 ${String(split)}%)` }} /> : null}
          <span aria-hidden className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-linear-to-b from-brand-cyan via-brand-blue to-brand-violet shadow-glow-sm" style={{ left: `${String(split)}%` }}>
            <span className="material-hud absolute top-1/2 left-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 text-fg shadow-glow-sm">
              <ArrowLeftRight className="size-3.5" />
            </span>
          </span>
          <span className={cn(HUD_CHIP, "pointer-events-none absolute top-2.5 left-2.5 max-w-[45%] truncate")}>{t("A・{labelA}", { labelA })}</span>
          <span className={cn(HUD_CHIP, "pointer-events-none absolute top-2.5 right-2.5 max-w-[45%] truncate")}>{t("B・{labelB}", { labelB })}</span>
        </div>
      </div>
      <label htmlFor={`${id}-split`} className="flex items-center gap-2 text-caption text-fg-secondary">
        <span className="shrink-0">{t("分隔位置")}</span>
        <input id={`${id}-split`} type="range" min={0} max={100} step={1} value={split} onChange={(event) => { setSplit(Number(event.target.value)); }} aria-valuetext={t("左側 A {split}%、右側 B {n}%", { split, n: 100 - split })} className="min-w-0 flex-1 accent-action" />
        <span className="machine min-w-10 shrink-0 text-right">{`${String(split)}%`}</span>
      </label>
    </div>
  );
}
