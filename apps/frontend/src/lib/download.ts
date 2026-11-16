// 下載與副檔名：媒體下載檔名一律標示 preview／final 等用途。

const EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "application/json": "json",
  "application/zip": "zip",
  "application/x-ndjson": "jsonl",
  "text/plain": "txt",
};

export function extensionFor(mediaType: string): string {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[base] ?? "bin";
}

/** 例：preview-1a2b3c4d.mp4、final-1a2b3c4d.mp4。 */
export function labeledFileName(label: string, id: string, mediaType: string): string {
  const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, "-") || "file";
  return `${safeLabel}-${id.slice(0, 8)}.${extensionFor(mediaType)}`;
}

/** How long a download's object URL stays valid (some browsers start reading it only after click() returns). */
const REVOKE_AFTER_MS = 30_000;

/** Saves a locally produced Blob through a temporary object URL (revoked after REVOKE_AFTER_MS). */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

const BOM = String.fromCharCode(0xfeff);

/** Text file; CSV gets a UTF-8 BOM so spreadsheets read CJK text correctly. */
export function downloadText(fileName: string, text: string, mediaType: string): void {
  downloadBlob(fileName, new Blob([mediaType.startsWith("text/csv") ? `${BOM}${text}` : text], { type: mediaType }));
}

/** 以 Blob 下載 JSON（本機產生的內容，例如 scene 草稿）。 */
export function downloadJson(fileName: string, value: unknown): void {
  downloadBlob(fileName, new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
}
