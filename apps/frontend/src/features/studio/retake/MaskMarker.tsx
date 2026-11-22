// Marking the object of a mask directly on the picture. The source plays in the Studio monitor; a click on the picture
// pauses it, takes that native frame out of the source (the frame tool measures its clock, so the mark lands on the
// exact frame the segmenter will see) and puts the point there — a foreground point, a background point, or a box
// dragged across the object. Marked frames are chips to go back to; frame numbers, pixel inputs, the object number and
// the propagation direction wait under 進階.
import { Eraser, Minus, Plus, SquareDashed, Undo2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import type { WireTypedValue } from "@/api/types";
import { Disclosure } from "@/components/common/Disclosure";
import { extractedFrame, natural, useMaskFramePreview, type FrameAddress } from "@/components/common/maskFramePreview";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import {
  boxFrom, frameKey, frameLabel, inside, isBox, isDirection, MASK_ANNOTATIONS, MAX_OBJECT, MAX_POINTS, numberField, readAnnotation,
  type Box, type Direction, type Mark, type MarkTool, type Point, type XY,
} from "./maskAnnotation";
import { RetakeMonitor } from "./RetakeMonitor";

interface Props {
  source: FileRef;
  value: WireTypedValue | null;
  onChange: (value: WireTypedValue | null) => void;
  disabled: boolean;
  /** Sequence fps, for the transport. */
  fps: number;
  /** More tools under the marking ones (the mask route, generating, the result). */
  children?: ReactNode;
}

/** A click made on the moving picture, in 0–1 of its box, waiting for its native frame. */
type Pending = { kind: "point"; at: XY } | { kind: "box"; a: XY; b: XY };

const TOOLS: readonly { id: MarkTool; label: () => string; icon: ReactNode }[] = [
  { id: "positive", label: () => t("前景點"), icon: <Plus aria-hidden /> },
  { id: "negative", label: () => t("背景點"), icon: <Minus aria-hidden /> },
  { id: "box", label: () => t("選取框"), icon: <SquareDashed aria-hidden /> },
];

function normalized(event: PointerEvent): XY {
  const r = event.currentTarget.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) };
}

function MarkerBody({ source, value, onChange, disabled, fps, children }: Props) {
  const stored = readAnnotation(value);
  const doc = stored?.source_sha256 === source.sha256 ? stored : null;
  const stale = stored !== null && doc === null;
  const reader = useMaskFramePreview(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [request, setRequest] = useState<FrameAddress | null>(null);
  const [target, setTarget] = useState("0");
  const [loaded, setLoaded] = useState("");
  const [failedImage, setFailedImage] = useState("");
  const [draftId, setDraftId] = useState("1");
  const [draftDirection, setDraftDirection] = useState<Direction>("both");
  const [tool, setTool] = useState<MarkTool>("positive");
  const [coords, setCoords] = useState(["", "", "", ""]);
  const [message, setMessage] = useState("");
  const [drag, setDrag] = useState<{ start: XY; end: XY } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [liveDrag, setLiveDrag] = useState<{ a: XY; b: XY } | null>(null);
  const toolsId = useId();
  const objectId = doc?.object_id ?? numberField(draftId);
  const trackDirection = doc?.direction ?? draftDirection;
  const still = request ? extractedFrame(reader.run, "source", source, request) : null;
  const identity = still ? [source.sha256, still.index, still.file.sha256].join("/") : "";
  const width = still?.width ?? doc?.width ?? 0;
  const height = still?.height ?? doc?.height ?? 0;
  const badSize = Boolean(still && doc && (doc.width !== width || doc.height !== height));
  const frame = still ? { frame_index: still.index } : null;
  const marks = doc?.marks ?? [];
  const start = still?.file.metadata["mark_start_us"], end = still?.file.metadata["mark_end_us"];
  const hasClock = natural(start) && natural(end, start);
  // Historical microsecond marks and today's ordinal marks share the segmentation provider's measured clock.
  const mark = still && hasClock ? marks.find(row => row.frame_index === still.index ||
    (row.time_us !== undefined && row.time_us >= start && row.time_us < end)) : undefined;
  const broken = value !== null && !stored;
  const canMark = !disabled && !broken && !badSize && !!frame && hasClock && natural(objectId, 1) && objectId <= MAX_OBJECT;
  const ready = canMark && loaded === identity;
  const pickable = !disabled && !broken && reader.available && !reader.busy;

  useEffect(() => {
    if (stale) onChange(null);
  }, [stale, onChange]);

  function publish(next: Mark[], id: number | null = objectId, dir = trackDirection) {
    if (disabled || broken || !natural(id, 1) || id > MAX_OBJECT || badSize || !width || !height) return;
    if (next.length > 0 && !next.some((row) => row.box !== undefined || row.points.some((p) => p.label === 1))) {
      setMessage(t("請至少保留一個前景點或選取框。"));
      return;
    }
    setMessage("");
    onChange(next.length ? { type_id: MASK_ANNOTATIONS, value: {
      version: 1, ...(doc?.revision !== undefined ? { revision: doc.revision } : {}), source_sha256: source.sha256, width, height, object_id: id, direction: dir, marks: next,
    } } : null);
  }
  function writeMark(points: Point[], box?: Box) {
    if (!frame) return;
    const rest = marks.filter(row => row !== mark);
    if (points.length === 0 && !box) { publish(rest); return; }
    const next: Mark = { ...frame, points, ...(box ? { box } : {}) };
    publish(mark ? marks.map(row => row === mark ? next : row) : [...rest, next]);
  }
  function addPoint(at: XY, label: 0 | 1) {
    if ((mark?.points.length ?? 0) >= MAX_POINTS) { setMessage(t("同一幀最多可放 64 個點。")); return; }
    writeMark([...(mark?.points ?? []), { ...at, label }], mark?.box);
  }
  const toPixel = (n: XY): XY => ({ x: Math.min(width - 1, Math.floor(n.x * width)), y: Math.min(height - 1, Math.floor(n.y * height)) });
  function applyPending(next: Pending) {
    if (next.kind === "point") { addPoint(toPixel(next.at), tool === "negative" ? 0 : 1); return; }
    const box = boxFrom(toPixel(next.a), toPixel(next.b));
    if (isBox(box, width, height)) writeMark(mark?.points ?? [], box);
  }
  function numberMark() {
    if (!ready) return;
    const [x, y, right, bottom] = coords.map(numberField);
    if (!inside(x, width) || !inside(y, height)) { setMessage(t("座標必須落在原始畫面內。")); return; }
    if (tool !== "box") { addPoint({ x, y }, tool === "negative" ? 0 : 1); return; }
    const bounds = [x, y, right, bottom];
    if (!isBox(bounds, width, height)) { setMessage(t("右下角必須在左上角的右下方，且位於畫面內。")); return; }
    writeMark(mark?.points ?? [], bounds);
  }
  function selectFrame(row: FrameAddress, waiting: Pending | null = null) {
    setDrag(null);
    setFailedImage("");
    setLoaded("");
    setMessage("");
    setPending(waiting);
    setRequest(row);
    reader.inspect({ source }, row, t("原片影格"));
  }
  /** The transport moved: the picture is the moving source again. */
  function release() {
    setRequest(null);
    setLoaded("");
    setFailedImage("");
    setDrag(null);
    setPending(null);
  }
  function hereFrame(): FrameAddress | null {
    const video = videoRef.current;
    if (!video) return null;
    video.pause();
    return { time_us: Math.round(video.currentTime * 1_000_000) };
  }
  function goTo(row: Mark) {
    const video = videoRef.current;
    if (video && row.frame_index !== undefined) { video.pause(); video.currentTime = row.frame_index / fps; }
    else if (video && row.time_us !== undefined) { video.pause(); video.currentTime = row.time_us / 1_000_000; }
    selectFrame(row.frame_index !== undefined ? { frame_index: row.frame_index } : { time_us: row.time_us });
  }

  const bounds = drag ? boxFrom(drag.start, drag.end) : mark?.box;
  const pointRows = withOccurrenceKeys(mark?.points ?? [], (p) => [p.x, p.y, p.label].join(","));
  const pixel = (event: PointerEvent<SVGSVGElement>): XY => toPixel(normalized(event));
  const showStill = still !== null && loaded === identity;
  const radius = Math.max(width, height) / 90;

  // On the moving picture: a click (or a drag for a box) asks for this native frame, then lands on it.
  const pickLayer = !showStill && (
    <div
      aria-hidden
      className={cn("absolute inset-0 touch-none", pickable ? "cursor-crosshair" : "cursor-not-allowed")}
      onPointerDown={(event) => {
        if (!pickable || !event.isPrimary || event.button !== 0) return;
        const at = normalized(event);
        if (tool !== "box") {
          const here = hereFrame();
          if (here) selectFrame(here, { kind: "point", at });
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        videoRef.current?.pause();
        setLiveDrag({ a: at, b: at });
      }}
      onPointerMove={(event) => { if (liveDrag && event.isPrimary) setLiveDrag({ ...liveDrag, b: normalized(event) }); }}
      onPointerUp={(event) => {
        if (!liveDrag || !event.isPrimary) return;
        const b = normalized(event);
        setLiveDrag(null);
        const here = hereFrame();
        if (here && Math.abs(b.x - liveDrag.a.x) > 0.005 && Math.abs(b.y - liveDrag.a.y) > 0.005) selectFrame(here, { kind: "box", a: liveDrag.a, b });
      }}
      onPointerCancel={() => { setLiveDrag(null); }}
    >
      {(liveDrag ?? (pending?.kind === "box" ? pending : null)) && (() => {
        const box = liveDrag ?? (pending?.kind === "box" && reader.error === null ? pending : null);
        if (!box) return null;
        return <span className="absolute border-2 border-dashed border-white/90" style={{
          left: `${String(Math.min(box.a.x, box.b.x) * 100)}%`, top: `${String(Math.min(box.a.y, box.b.y) * 100)}%`,
          width: `${String(Math.abs(box.b.x - box.a.x) * 100)}%`, height: `${String(Math.abs(box.b.y - box.a.y) * 100)}%`,
        }} />;
      })()}
      {pending?.kind === "point" && reader.error === null && <span className="absolute size-3 -translate-1/2 animate-glow-pulse rounded-full border-2 border-white bg-action" style={{ left: `${String(pending.at.x * 100)}%`, top: `${String(pending.at.y * 100)}%` }} />}
    </div>
  );

  const overlay = <>
    {still && <img key={identity} src={mediaUrl(still.file.node_id, still.file.file_id)} alt={frameLabel({ frame_index: still.index })}
      width={width} height={height} className={cn("absolute inset-0 size-full object-fill", showStill ? "animate-fade-in" : "opacity-0")}
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth !== width || event.currentTarget.naturalHeight !== height) { setFailedImage(identity); return; }
        setLoaded(identity);
        if (pending && canMark) applyPending(pending);
        setPending(null);
      }}
      onError={() => { setFailedImage(identity); setPending(null); }} />}
    {showStill && <svg className={cn("absolute inset-0 size-full touch-none", ready ? "cursor-crosshair" : "cursor-not-allowed")} viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-hidden="true"
      onPointerDown={(e) => {
        if (!ready || !e.isPrimary || e.button !== 0) return;
        const p = pixel(e);
        if (tool !== "box") { addPoint(p, tool === "negative" ? 0 : 1); return; }
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ start: p, end: p });
      }}
      onPointerMove={(e) => { if (drag && e.isPrimary) setDrag({ ...drag, end: pixel(e) }); }}
      onPointerUp={(e) => {
        if (!drag || !e.isPrimary) return;
        const box = boxFrom(drag.start, pixel(e));
        setDrag(null);
        if (isBox(box, width, height)) writeMark(mark?.points ?? [], box);
      }}
      onPointerCancel={() => { setDrag(null); }} onLostPointerCapture={() => { setDrag(null); }}>
      {bounds && <rect x={bounds[0]} y={bounds[1]} width={bounds[2] - bounds[0]} height={bounds[3] - bounds[1]}
        fill="rgb(79 123 255 / 0.12)" stroke="white" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />}
      {pointRows.map(({ item: p, key: id }) => <circle key={id} cx={p.x} cy={p.y} r={radius}
        fill={p.label ? "var(--color-action)" : "var(--color-danger)"} stroke="white" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
    </svg>}
    {pickLayer}
    {still && showStill && <span className="material-hud pointer-events-none absolute top-2 left-2 rounded-full border border-white/10 px-2 py-0.5 text-caption text-fg">{frameLabel({ frame_index: still.index })}</span>}
  </>;

  const count = (label: 0 | 1) => mark?.points.filter((p) => p.label === label).length ?? 0;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(17rem,1fr)]">
      <div className="grid min-w-0 content-start gap-2">
        <RetakeMonitor src={mediaUrl(source.node_id, source.file_id)} fps={fps} label={t("標記用來源影片")} videoRef={videoRef}
          frames={natural(source.metadata["frame_count"]) ? source.metadata["frame_count"] : null} overlay={overlay} onTransport={release} />
        <div className="min-h-5 text-caption" aria-live="polite">
          {(broken || badSize) ? <span role="alert" className="inline-flex items-center gap-2 text-danger">{t("標記資料與目前影片不相容。")}
            <Button size="sm" variant="quiet" onClick={() => { onChange(null); release(); }}>{t("清除標記")}</Button></span>
            : !reader.available ? <span className="text-warning">{t("請啟動支援影格時鐘的取影格元件。")}</span>
            : reader.error !== null ? <span role="alert" className="text-warning">{reader.error}</span>
            : request && (reader.busy || (still !== null && loaded !== identity && failedImage !== identity)) ? <span className="text-fg-secondary">{t("正在取出這一幀…")}</span>
            : request && !reader.busy && reader.run?.state === "succeeded" && (!still || !hasClock || failedImage === identity) ? <span role="alert" className="text-warning">{t("預覽影格與目前的來源或版本不符。")}</span>
            : <span className="text-fg-tertiary">{showStill ? t("點一下加點，按播放或拖動時間軸可換到其他畫面。") : t("暫停在要標記的畫面，直接在畫面上點選物件。")}</span>}
        </div>
      </div>
      <div className="grid min-w-0 content-start gap-3 text-data text-fg-secondary">
        <div role="radiogroup" aria-labelledby={`${toolsId}-label`} className="grid gap-1.5">
          <span id={`${toolsId}-label`} className="text-caption text-fg-tertiary">{t("標記工具")}</span>
          <div className="grid grid-cols-3 gap-1.5">
            {TOOLS.map((item) => (
              <button key={item.id} type="button" role="radio" aria-checked={tool === item.id} disabled={disabled}
                onClick={() => { setTool(item.id); setDrag(null); }}
                className={cn(CHOICE_BASE, "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-data [&_svg]:size-4", tool === item.id ? CHOICE_SELECTED : CHOICE_IDLE)}>
                {item.icon}{item.label()}
              </button>
            ))}
          </div>
        </div>
        {mark ? <div className="flex flex-wrap items-center gap-2">
          <span className="text-fg">{t("這一幀：前景 {fg}・背景 {bg}", { fg: count(1), bg: count(0) })}{mark.box ? t("・選取框") : ""}</span>
          <Button size="sm" variant="quiet" icon={<Undo2 aria-hidden />} disabled={!ready || mark.points.length === 0}
            onClick={() => { writeMark(mark.points.slice(0, -1), mark.box); }}>{t("復原上一點")}</Button>
          <Button size="sm" variant="quiet" icon={<Eraser aria-hidden />} disabled={!ready}
            onClick={() => { publish(marks.filter((row) => frameKey(row) !== frameKey(mark))); }}>{t("清除本幀")}</Button>
        </div> : null}
        {marks.length > 0 && <div className="grid gap-1.5">
          <span className="text-caption text-fg-tertiary">{t("已標記影格")}</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("已標記影格")}>
            {marks.map((row) => <Button size="sm" variant="secondary" key={frameKey(row)} disabled={!reader.available || reader.busy} aria-pressed={mark === row}
              onClick={() => { goTo(row); }}>{frameLabel(row)}</Button>)}
          </div>
        </div>}
        {message && <p role="status" className="text-warning">{message}</p>}
        {children}
        <Disclosure summary={t("進階")}>
          <div className="grid gap-3">
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="grid gap-1">{t("原生影格編號")}<Input compact type="number" min={0} step={1} value={target} onChange={(e) => { setTarget(e.target.value); }} /></label>
              <Button size="sm" disabled={!pickable || !natural(numberField(target)) || (numberField(target) ?? 0) > 100000}
                onClick={() => { const n = numberField(target); if (natural(n)) selectFrame({ frame_index: n }); }}>{t("取出原生影格")}</Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1">{t("物件編號")}<Input compact type="number" min={1} max={MAX_OBJECT} step={1} value={doc?.object_id ?? draftId}
                onChange={(e) => {
                  const s = e.target.value;
                  setDraftId(s);
                  const id = numberField(s);
                  if (doc && natural(id, 1) && id <= MAX_OBJECT) publish(marks, id);
                }} /></label>
              <label className="grid gap-1">{t("遮罩傳播方向")}<Select compact value={trackDirection} onChange={(e) => {
                const dir = e.target.value;
                if (isDirection(dir)) { setDraftDirection(dir); if (doc) publish(marks, objectId, dir); }
              }}>
                <option value="both">{t("雙向")}</option><option value="forward">{t("向後續影格傳播")}</option>
                <option value="backward">{t("向先前影格傳播")}</option>
              </Select></label>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {(tool === "box" ? [t("左側 X"), t("頂端 Y"), t("右側 X"), t("底部 Y")] : [t("像素 X"), t("像素 Y")]).map((label, i) =>
                <label className="grid min-w-16 flex-1 gap-1" key={label}>{label}<Input compact type="number" min={0} max={Math.max(0, (i % 2 ? height : width) - 1)} step="any" value={coords[i] ?? ""}
                  onChange={(e) => { const v = e.target.value; setCoords((old) => old.map((x, j) => j === i ? v : x)); }} /></label>)}
              <Button size="sm" disabled={!ready} onClick={numberMark}>{t("套用座標")}</Button>
            </div>
            {mark && <ul className="grid gap-1 text-caption">
              {pointRows.map(({ item: p, key: id }, i) => <li key={id} className="flex items-center justify-between gap-2">
                <span className="machine">{p.label ? t("前景點") : t("背景點")} ({p.x}, {p.y})</span>
                <Button size="sm" variant="quiet" disabled={!ready} onClick={() => { writeMark(mark.points.filter((_, j) => j !== i), mark.box); }}>{t("移除這個點")}</Button>
              </li>)}
              {mark.box && <li className="flex items-center justify-between gap-2">
                <span className="machine">{t("選取框")} ({mark.box.join(", ")})</span>
                <Button size="sm" variant="quiet" disabled={!ready} onClick={() => { writeMark(mark.points); }}>{t("移除選取框")}</Button>
              </li>}
            </ul>}
          </div>
        </Disclosure>
      </div>
    </div>
  );
}

/** The marking monitor and its tools; remounts for another source. */
export function MaskMarker(props: Props) {
  return <MarkerBody key={props.source.sha256} {...props} />;
}
