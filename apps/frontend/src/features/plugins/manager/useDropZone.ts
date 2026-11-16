// 整個管理視窗都是放置區：把 .phasynplugin 檔拖進來就開始驗證（只取第一個檔案）。現在不能安裝時顯示原因、不接受放下。
import { useState, type DragEvent } from "react";

export type DropVerdict = "accept" | "reject";

const hasFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");

export function useDropZone(onFile: (file: File) => void, blocked: string | null) {
  const [dropping, setDropping] = useState<DropVerdict | null>(null);
  const verdict: DropVerdict = blocked ? "reject" : "accept";
  return {
    dropping,
    reset: () => setDropping(null),
    handlers: {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(verdict);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = blocked ? "none" : "copy";
        if (dropping !== verdict) setDropping(verdict);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(null);
        const file = event.dataTransfer.files[0];
        if (file && !blocked) onFile(file);
      },
    },
  };
}
