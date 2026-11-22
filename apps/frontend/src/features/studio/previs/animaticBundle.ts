import type { StudioLibraryItem, StudioPrevis, StudioProject, StudioShot } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { valuesEqual } from "@/lib/json";
import { DEFAULT_SCENE } from "./composition";
import type { PrevisPainter } from "./spacePainter";

const MIB = 1024 * 1024;
const AUDIO_RATE = 48_000;

interface Source {
  item_id: string;
  sha256: string;
}
export interface AnimaticHeader {
  project_id: string;
  revision: number;
  shot_id: string;
  start: number;
  end: number;
  fps_num: number;
  fps_den: number;
  width: number;
  height: number;
  depth: boolean;
  scene: StudioPrevis;
  layer_sources: Source[];
  audio: (Source & { start_sample: number }) | null;
}

export function rangeIssue(start: number, end: number, shot: StudioShot, format: StudioProject["format"]) {
  const count = end - start;
  const pixels = format.width * format.height;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || count < 1 || end > shot.frames)
    return t("請選擇鏡頭內的完整影格範圍。");
  if (format.width % 2 || format.height % 2) return t("動態預演的寬度與高度都必須是偶數。");
  if (count > 1800 || pixels > 8_388_608 || count * pixels > 1_000_000_000)
    return t("此區段超過預演容量，請縮短範圍或降低解析度。");
  const fps = format.fps.num / format.fps.den;
  if (fps < 1 || fps > 240) return t("預演影格率須介於每秒 1 至 240 格。");
  return null;
}

export function sourceHeader(project: StudioProject, saved: StudioProject, shot: StudioShot, scene: StudioPrevis,
  start: number, end: number, depth: boolean, audio: StudioLibraryItem | undefined, sample: number): AnimaticHeader {
  const version = saved.shots.find((s) => s.shot_id === shot.shot_id);
  const library = project.library ?? [];
  const stored = saved.library ?? [];
  const changed = () => new Error(t("預演或來源素材已變更，請重新確認後再匯出。"));
  if (version?.frames !== shot.frames || !valuesEqual(saved.format, project.format) ||
      !valuesEqual(version.previs ?? DEFAULT_SCENE, scene)) throw changed();
  const ids = new Set(scene.layers.flatMap((l) => l.kind === "image" && l.item_id != null && l.item_id !== "" ? [l.item_id] : []));
  function source(id: string, kind: StudioLibraryItem["kind"]): Source {
    const item = library.find((i) => i.item_id === id && i.kind === kind);
    const file = stored.find((i) => i.item_id === id && i.kind === kind)?.file;
    if (!item || !file || !valuesEqual(item.file, file)) throw changed();
    return { item_id: id, sha256: file.sha256 };
  }
  return { project_id: saved.project_id, revision: saved.revision, shot_id: shot.shot_id, start, end, depth, scene,
    width: saved.format.width, height: saved.format.height, fps_num: saved.format.fps.num, fps_den: saved.format.fps.den,
    layer_sources: [...ids].map((id) => source(id, "image")),
    audio: audio ? { ...source(audio.item_id, "audio"), start_sample: sample } : null };
}

export function audioOffsetIssue(item: StudioLibraryItem | undefined, sample: number) {
  if (!item) return null;
  if (!Number.isSafeInteger(sample) || sample < 0 || sample > 2_147_483_647 ||
      (typeof item.duration_seconds === "number" && sample >= item.duration_seconds * AUDIO_RATE))
    return t("請選擇音訊範圍內的起始取樣。");
  return null;
}

interface Sink {
  append: (blob: Blob) => Promise<void>;
  finish: () => Promise<Blob>;
  dispose: () => Promise<void>;
  limit: number;
}

function memorySink(): Sink {
  const parts: Blob[] = [];
  return {
    limit: 32 * MIB,
    append: (blob) => { parts.push(blob); return Promise.resolve(); },
    finish: () => Promise.resolve(new Blob(parts)),
    dispose: () => { parts.length = 0; return Promise.resolve(); },
  };
}

async function diskSink(): Promise<Sink> {
  let dir: FileSystemDirectoryHandle;
  try { dir = await navigator.storage.getDirectory(); } catch { return memorySink(); }
  const name = `phasyn-animatic-${crypto.randomUUID()}.tmp`;
  const file = await dir.getFileHandle(name, { create: true });
  let writer: FileSystemWritableFileStream;
  try { writer = await file.createWritable(); } catch (cause) { await dir.removeEntry(name); throw cause; }
  let closed = false;
  return {
    limit: 512 * MIB,
    append: (blob) => writer.write(blob),
    finish: async () => { await writer.close(); closed = true; return file.getFile(); },
    dispose: async () => {
      try { if (!closed) await writer.abort(); } finally { await dir.removeEntry(name); }
    },
  };
}

function lengthOf(blob: Blob) {
  const bytes = new ArrayBuffer(4);
  new DataView(bytes).setUint32(0, blob.size, false);
  return new Blob([bytes]);
}
function canvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error(t("無法匯出預演 PNG。"))); }, "image/png");
  });
}

/** Keep a single painted frame in flight. The caller owns the temporary file through upload completion. */
export async function captureFrames(painter: PrevisPainter, header: AnimaticHeader, images: Map<string, HTMLImageElement>,
  signal: AbortSignal, progress: (count: number) => void) {
  const sink = await diskSink();
  const target = document.createElement("canvas");
  let size = 0;
  async function append(blob: Blob) {
    signal.throwIfAborted();
    size += blob.size;
    if (size > sink.limit) throw new Error(t("預演暫存容量上限為 {size} MiB，請縮短區段。", { size: sink.limit / MIB }));
    await sink.append(blob);
  }
  try {
    target.width = header.width;
    target.height = header.height;
    const info = new Blob([JSON.stringify(header)]);
    if (info.size > MIB) throw new Error(t("預演場景描述超過 1 MiB。"));
    await append(new Blob(["PHANIM01", lengthOf(info), info]));
    for (let frame = header.start; frame < header.end; frame += 1) {
      signal.throwIfAborted();
      painter.draw(target, header.scene, frame, images, header.depth);
      const png = await canvasPng(target);
      if (png.size > 32 * MIB) throw new Error(t("單張預演影格超過 32 MiB。"));
      await append(new Blob([lengthOf(png), png]));
      progress(frame - header.start + 1);
    }
    const blob = await sink.finish();
    return { blob, dispose: sink.dispose };
  } catch (cause) {
    await sink.dispose();
    throw cause;
  } finally {
    target.width = target.height = 1;
  }
}
