import { useEffect, useId, useState, type PointerEvent } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import type { WireTypedValue } from "@/api/types";
import { AssetVideo } from "@/components/common/AssetMedia";
import { extractedFrame, natural, useMaskFramePreview, type FrameAddress } from "./maskFramePreview";
import { linkedCaptions } from "@/components/common/linkedCaptions";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";

const TYPE = "media.mask-annotations.v1";
const MAX_POINTS = 64;
const MAX_OBJECT = 2_147_483_647;
type Direction = "forward" | "backward" | "both";
type Mode = "positive" | "negative" | "box";
interface XY { x: number; y: number }
type Point = XY & { label: 0 | 1 };
type Box = [number, number, number, number];
type Frame = FrameAddress;
type Mark = Frame & { points: Point[]; box?: Box };
interface Annotation { version: 1; revision?: number; source_sha256: string; width: number; height: number; object_id: number; direction: Direction; marks: Mark[] }

interface Props {
  source: FileRef;
  value: WireTypedValue | null;
  onChange: (value: WireTypedValue | null) => void;
  disabled: boolean;
}

function inside(n: unknown, bound: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n < bound;
}
function direction(value: unknown): value is Direction {
  return value === "forward" || value === "backward" || value === "both";
}
function isBox(v: unknown, w: number, h: number): v is Box {
  return Array.isArray(v) && v.length === 4 && inside(v[0], w) && inside(v[1], h)
    && inside(v[2], w) && inside(v[3], h) && v[0] < v[2] && v[1] < v[3];
}
function readMark(v: unknown, w: number, h: number): Mark | null {
  if (!isRecord(v)) return null;
  const { frame_index: index, time_us: time, points: rawPoints = [], box } = v;
  if (("time_us" in v) === ("frame_index" in v)) return null;
  const frame: Frame | null = natural(index) ? { frame_index: index } : natural(time) ? { time_us: time } : null;
  if (!frame || !Array.isArray(rawPoints) || rawPoints.length > MAX_POINTS) return null;
  if (box !== undefined && !isBox(box, w, h)) return null;
  const points: Point[] = [];
  for (const item of rawPoints as unknown[]) {
    if (!isRecord(item)) return null;
    const { x, y, label } = item;
    if (!inside(x, w) || !inside(y, h) || (label !== 0 && label !== 1)) return null;
    points.push({ x, y, label });
  }
  return points.length || box ? { ...frame, points, ...(box ? { box } : {}) } : null;
}
function read(value: WireTypedValue | null): Annotation | null {
  if (value?.type_id !== TYPE || !("value" in value) || !isRecord(value.value)) return null;
  const { version, revision, source_sha256, width, height, object_id, direction: dir, marks: rows } = value.value;
  if (version !== 1 || (revision !== undefined && (!natural(revision, 1) || revision > MAX_OBJECT)) || typeof source_sha256 !== "string" || !natural(width, 1) || !natural(height, 1)
    || !natural(object_id, 1) || object_id > MAX_OBJECT || !direction(dir) || !Array.isArray(rows)) return null;
  const marks: Mark[] = [];
  const frames = new Set<string>();
  for (const row of rows as unknown[]) {
    const mark = readMark(row, width, height);
    if (!mark || frames.has(key(mark))) return null;
    frames.add(key(mark));
    marks.push(mark);
  }
  return { version: 1, ...(revision !== undefined ? { revision } : {}), source_sha256, width, height, object_id, direction: dir, marks };
}
function key(frame: Frame): string {
  return frame.frame_index !== undefined ? `f${String(frame.frame_index)}` : `t${String(frame.time_us)}`;
}
function frameLabel(frame: Frame): string {
  return frame.frame_index !== undefined
    ? t("第 {index} 幀（從 0 起算）", { index: frame.frame_index })
    : t("距第一幀 {us} 微秒", { us: frame.time_us });
}
function numberField(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function MarkEditor({ source, value, disabled, onChange }: Props) {
  const stored = read(value);
  const doc = stored?.source_sha256 === source.sha256 ? stored : null;
  const stale = stored !== null && doc === null;
  const reader = useMaskFramePreview(true);
  const [unit, setUnit] = useState<"frame_index" | "time_us">("frame_index");
  const [target, setTarget] = useState("0");
  const [showStill, setShowStill] = useState(false);
  const [loaded, setLoaded] = useState("");
  const [failedImage, setFailedImage] = useState("");
  const [draftId, setDraftId] = useState("1");
  const [draftDirection, setDraftDirection] = useState<Direction>("both");
  const [mode, setMode] = useState<Mode>("positive");
  const [coords, setCoords] = useState(["", "", "", ""]);
  const [message, setMessage] = useState("");
  const [drag, setDrag] = useState<{ start: XY; end: XY } | null>(null);
  const helpId = useId();
  const objectId = doc?.object_id ?? numberField(draftId);
  const trackDirection = doc?.direction ?? draftDirection;
  const markTime = numberField(target);
  const requested: Frame | null = natural(markTime) ? (unit === "frame_index" ? { frame_index: markTime } : { time_us: markTime }) : null;
  const still = showStill && requested ? extractedFrame(reader.run, "source", source, requested) : null;
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
  const ready = !disabled && !broken && !badSize && !!frame && hasClock && loaded === identity && natural(objectId, 1) && objectId <= MAX_OBJECT;

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
    onChange(next.length ? { type_id: TYPE, value: {
      version: 1, ...(doc?.revision !== undefined ? { revision: doc.revision } : {}), source_sha256: source.sha256, width, height, object_id: id, direction: dir, marks: next,
    } } : null);
  }
  function setMark(points: Point[], box?: Box) {
    if (!ready) return;
    const rest = marks.filter(row => row !== mark);
    if (points.length === 0 && !box) { publish(rest); return; }
    const next: Mark = { ...frame, points, ...(box ? { box } : {}) };
    publish(mark ? marks.map(row => row === mark ? next : row) : [...rest, next]);
  }
  function addPoint(at: XY) {
    if ((mark?.points.length ?? 0) >= MAX_POINTS) { setMessage(t("同一幀最多可放 64 個點。")); return; }
    setMark([...(mark?.points ?? []), { ...at, label: mode === "negative" ? 0 : 1 }], mark?.box);
  }
  function boxFrom(a: XY, b: XY): Box {
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  }
  function numberMark() {
    const [x, y, right, bottom] = coords.map(numberField);
    if (!inside(x, width) || !inside(y, height)) { setMessage(t("座標必須落在原始畫面內。")); return; }
    if (mode !== "box") { addPoint({ x, y }); return; }
    const bounds = [x, y, right, bottom];
    if (!isBox(bounds, width, height)) { setMessage(t("右下角必須在左上角的右下方，且位於畫面內。")); return; }
    setMark(mark?.points ?? [], bounds);
  }
  function pixel(event: PointerEvent<SVGSVGElement>): XY {
    const r = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - r.left) * width / r.width))),
      y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - r.top) * height / r.height))),
    };
  }
  function preview() {
    setShowStill(false);
    setLoaded("");
    setFailedImage("");
    setDrag(null);
  }
  function selectFrame(row: Frame) {
    setDrag(null);
    setFailedImage("");
    setUnit(row.frame_index === undefined ? "time_us" : "frame_index");
    setTarget(String(row.frame_index ?? row.time_us));
    setMessage("");
    setShowStill(true);
    reader.inspect({ source }, row, t("原片影格"));
  }

  const bounds = drag ? boxFrom(drag.start, drag.end) : mark?.box;
  const pointRows = withOccurrenceKeys(mark?.points ?? [], (p) => [p.x, p.y, p.label].join(","));
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-3 rounded-lg border border-line p-3 text-data text-fg-secondary">
      <legend className="px-1 text-fg">{t("影片物件標記")}</legend>
      <p id={helpId}>{t("輸入影格編號或來源時間，取出原片影格後即可標記。")}</p>
      {(broken || badSize) && <div role="alert" className="flex items-center gap-2 text-danger">
        {t("標記資料與目前影片不相容。")}
        <Button size="sm" onClick={() => { onChange(null); preview(); }}>{t("清除標記")}</Button>
      </div>}
      <div className="relative mx-auto max-w-full overflow-hidden rounded-md bg-stage"
        style={{ width: still ? `min(100%, ${String(48 * width / height)}vh)` : "100%" }}>
        {showStill ? still ? <img key={identity} src={mediaUrl(still.file.node_id, still.file.file_id)} alt={frameLabel({ frame_index: still.index })}
          width={width} height={height} className="block h-auto w-full"
          onLoad={e => {
            if (e.currentTarget.naturalWidth === width && e.currentTarget.naturalHeight === height) setLoaded(identity);
            else setFailedImage(identity);
          }}
          onError={() => { setFailedImage(identity); }} /> : null :
          <AssetVideo captions={linkedCaptions(source.metadata)} src={mediaUrl(source.node_id, source.file_id)} preload="metadata" controls playsInline
            aria-label={t("標記用來源影片")} className="block max-h-[48vh] w-full object-contain" />}
        {still && ready && <svg className="absolute inset-0 size-full touch-none cursor-crosshair" viewBox={`0 0 ${String(width)} ${String(height)}`}
          aria-hidden="true"
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return;
            const p = pixel(e);
            if (mode !== "box") { addPoint(p); return; }
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ start: p, end: p });
          }}
          onPointerMove={(e) => { if (drag && e.isPrimary) setDrag({ ...drag, end: pixel(e) }); }}
          onPointerUp={(e) => {
            if (!drag || !e.isPrimary) return;
            const box = boxFrom(drag.start, pixel(e));
            setDrag(null);
            if (isBox(box, width, height)) setMark(mark?.points ?? [], box);
          }}
          onPointerCancel={() => { setDrag(null); }} onLostPointerCapture={() => { setDrag(null); }}>
          {bounds && <rect x={bounds[0]} y={bounds[1]} width={bounds[2] - bounds[0]} height={bounds[3] - bounds[1]}
            fill="none" stroke="white" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          {pointRows.map(({ item: p, key: id }) => <circle key={id} cx={p.x} cy={p.y} r={Math.max(width, height) / 100}
            fill={p.label ? "var(--color-action)" : "var(--color-danger)"} stroke="white" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
        </svg>}
      </div>
      {showStill && reader.busy && <p role="status">{t("載入預覽…")}</p>}
      {showStill && reader.error !== null && <p role="alert">{reader.error}</p>}
      {showStill && !reader.busy && reader.run?.state === "succeeded" && (!still || !hasClock || failedImage === identity) &&
        <p role="alert">{t("預覽影格與目前的來源或版本不符。")}</p>}
      {still && <span className="text-caption">{frameLabel({ frame_index: still.index })}</span>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label>{t("標記位置單位")}<Select value={unit} onChange={(e) => { preview(); setUnit(e.target.value === "time_us" ? "time_us" : "frame_index"); setTarget(""); }}>
          <option value="frame_index">{t("原生影格編號")}</option><option value="time_us">{t("距第一幀的微秒數")}</option>
        </Select></label>
        <label>{unit === "frame_index" ? t("原生影格編號") : t("距第一幀的微秒數")}<Input type="number" min={0} step={1} value={target}
          onChange={(e) => { preview(); setTarget(e.target.value); }} /></label>
        <label>{t("物件編號")}<Input type="number" min={1} max={MAX_OBJECT} step={1} value={doc?.object_id ?? draftId}
          onChange={(e) => {
            const s = e.target.value;
            setDraftId(s);
            const id = numberField(s);
            if (doc && natural(id, 1) && id <= MAX_OBJECT) publish(marks, id);
          }} /></label>
        <label>{t("遮罩傳播方向")}<Select value={trackDirection} onChange={(e) => {
          const dir = e.target.value;
          if (direction(dir)) { setDraftDirection(dir); if (doc) publish(marks, objectId, dir); }
        }}>
          <option value="both">{t("雙向")}</option><option value="forward">{t("向後續影格傳播")}</option>
          <option value="backward">{t("向先前影格傳播")}</option>
        </Select></label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!reader.available || !requested || broken || reader.busy || (requested.frame_index ?? 0) > 100000}
          aria-describedby={helpId} onClick={() => { if (requested) selectFrame(requested); }}>{t("取出原生影格")}</Button>
        {showStill && <Button size="sm" variant="quiet" onClick={preview}>{t("返回影片定位")}</Button>}
        {still && <>
          <Button size="sm" variant="secondary" disabled={!reader.available || reader.busy || still.index === 0} onClick={() => { selectFrame({ frame_index: still.index - 1 }); }}>{t("前一幀")}</Button>
          <Button size="sm" variant="secondary" disabled={!reader.available || reader.busy || still.index >= Math.min(still.count - 1, 100000)} onClick={() => { selectFrame({ frame_index: still.index + 1 }); }}>{t("後一幀")}</Button>
        </>}
        {!reader.available && <span role="status">{t("請啟動支援影格時鐘的取影格元件。")}</span>}
      </div>
      <label>{t("標記工具")}<Select value={mode} onChange={(e) => {
        const m = e.target.value;
        if (m === "positive" || m === "negative" || m === "box") { setMode(m); setDrag(null); }
      }}>
        <option value="positive">{t("前景點")}</option><option value="negative">{t("背景點")}</option><option value="box">{t("選取框")}</option>
      </Select></label>
      <div className="flex flex-wrap items-end gap-2">
        {(mode === "box" ? [t("左側 X"), t("頂端 Y"), t("右側 X"), t("底部 Y")] : [t("像素 X"), t("像素 Y")]).map((label, i) =>
          <label className="min-w-16 flex-1" key={label}>{label}<Input type="number" min={0} max={(i % 2 ? height : width) - 1} step="any" value={coords[i] ?? ""}
            onChange={(e) => { const v = e.target.value; setCoords((old) => old.map((x, j) => j === i ? v : x)); }} /></label>)}
        <Button size="sm" disabled={!ready} onClick={numberMark}>{t("套用座標")}</Button>
      </div>
      {message && <p role="status">{message}</p>}
      {mark && <div className="grid gap-1">
        {pointRows.map(({ item: p, key: id }, i) => <div key={id} className="flex flex-wrap items-center justify-between gap-2">
          <span>{p.label ? t("前景點") : t("背景點")} ({p.x}, {p.y})</span>
          <Button size="sm" variant="quiet" disabled={!ready} onClick={() => { setMark(mark.points.filter((_, j) => j !== i), mark.box); }}>{t("移除這個點")}</Button>
        </div>)}
        {mark.box && <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("選取框")} ({mark.box.join(", ")})</span>
          <Button size="sm" variant="quiet" disabled={!ready} onClick={() => { setMark(mark.points); }}>{t("移除選取框")}</Button>
        </div>}
      </div>}
      {marks.length > 0 && <div className="flex flex-wrap gap-2" role="group" aria-label={t("已標記影格")}>
        {marks.map((row) => <Button size="sm" variant="secondary" key={key(row)} disabled={!reader.available || reader.busy} aria-pressed={mark === row}
          onClick={() => { selectFrame(row); }}>{frameLabel(row)}</Button>)}
        {mark && <Button size="sm" variant="quiet" disabled={!ready} onClick={() => { publish(marks.filter((row) => key(row) !== key(mark))); }}>{t("移除本幀標記")}</Button>}
      </div>}
    </fieldset>
  );
}

export function MaskAnnotationInput(props: Props) {
  return <MarkEditor key={props.source.sha256} {...props} />;
}
