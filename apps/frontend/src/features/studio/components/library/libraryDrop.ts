// Files dropped on the asset library: only images, video and sound are accepted (the rest is skipped with a note).
import type { DragEvent } from "react";

/** 拖進來的檔案（dragenter／dragover 時只看得到類型）：全部都有類型而且沒有一個是圖片、影片或聲音＝不收。 */
export function dragVerdict(event: DragEvent<HTMLElement>): "accept" | "reject" {
  const files = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
  if (files.length === 0) return "accept";
  return files.every((item) => item.type !== "" && !/^(image|video|audio)\//.test(item.type)) ? "reject" : "accept";
}

export const acceptsFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");
export const mediaFiles = (files: Iterable<File>) => Array.from(files).filter((file) => /^(image|video|audio)\//.test(file.type));
