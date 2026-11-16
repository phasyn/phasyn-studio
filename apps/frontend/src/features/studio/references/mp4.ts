// ISO BMFF（MP4／MOV）容器：只讀 box 標頭與 moov，判斷有沒有音軌（trak/mdia/hdlr 的 handler 是 soun）。
// 瀏覽器的 <video> 在 Chrome 沒有可靠的「有沒有音軌」API；這裡讀容器本身。不是 MP4／MOV、moov 太大或
// 結構讀不懂 → null（未知），不猜。
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const MAX_TOP_LEVEL_BOXES = 256;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) >>> 0) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

interface BoxHeader {
  type: string;
  size: number;
  headerSize: number;
}

/**
 * 讀一個 box 標頭（bytes[offset…limit) 內可讀到的標頭欄位）；size 0＝延伸到容器結尾（remaining bytes）；
 * largesize（size 1）超過 2^53 時回 null。
 */
function header(bytes: Uint8Array, offset: number, limit: number, remaining: number = limit - offset): BoxHeader | null {
  if (offset + 8 > limit) return null;
  let size = uint32(bytes, offset);
  const type = fourcc(bytes, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const high = uint32(bytes, offset + 8);
    if (high > 0x1fffff) return null;
    size = high * 2 ** 32 + uint32(bytes, offset + 12);
    headerSize = 16;
  } else if (size === 0) {
    size = remaining;
  }
  if (size < headerSize) return null;
  return { type, size, headerSize };
}

/** 一段 bytes 內的子 box（type 與內容範圍）。 */
function children(bytes: Uint8Array, start: number, end: number): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = header(bytes, offset, end);
    if (!box || offset + box.size > end) break;
    out.push({ type: box.type, start: offset + box.headerSize, end: offset + box.size });
    offset += box.size;
  }
  return out;
}

/** moov 內容裡各 trak 的 handler（vide／soun／…）。 */
export function trackHandlers(moov: Uint8Array): string[] {
  const handlers: string[] = [];
  for (const trak of children(moov, 0, moov.length).filter((box) => box.type === "trak")) {
    const mdia = children(moov, trak.start, trak.end).find((box) => box.type === "mdia");
    if (!mdia) continue;
    const hdlr = children(moov, mdia.start, mdia.end).find((box) => box.type === "hdlr");
    // FullBox：version+flags（4）＋pre_defined／QuickTime component type（4）＋handler_type（4）
    if (hdlr && hdlr.end - hdlr.start >= 12) handlers.push(fourcc(moov, hdlr.start + 8));
  }
  return handlers;
}

/** 有音軌 → true；確定只有非音訊軌 → false；不是 ISO BMFF 或讀不懂 → null。 */
export async function mp4HasAudio(source: ByteSource): Promise<boolean | null> {
  let offset = 0;
  for (let index = 0; index < MAX_TOP_LEVEL_BOXES && offset + 8 <= source.size; index += 1) {
    const head = await source.read(offset, 16);
    const box = header(head, 0, Math.min(head.length, source.size - offset), source.size - offset);
    if (!box) return null;
    if (index === 0 && box.type !== "ftyp") return null;
    if (box.type === "moov") {
      const length = Math.min(box.size, source.size - offset) - box.headerSize;
      if (length <= 0 || length > MAX_MOOV_BYTES) return null;
      const handlers = trackHandlers(await source.read(offset + box.headerSize, length));
      if (handlers.length === 0) return null;
      return handlers.includes("soun");
    }
    offset += box.size;
  }
  return null;
}

/** File／Blob → ByteSource（只讀需要的片段）。 */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}
