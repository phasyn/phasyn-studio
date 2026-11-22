import { useEffect, useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";

/** 原圖的實際像素（分頁隱藏時 lazy 圖片不會載入，所以另外量）。 */
export function useImageSize(file: FileRef): [{ width: number; height: number } | null, (size: { width: number; height: number }) => void] {
  const key = `${file.node_id}/${file.file_id}`;
  const [state, setState] = useState<{ key: string; size: { width: number; height: number } } | null>(null);
  useEffect(() => {
    const image = new Image();
    image.onload = () => { setState({ key, size: { width: image.naturalWidth, height: image.naturalHeight } }); };
    image.src = mediaUrl(file.node_id, file.file_id);
    return () => {
      image.onload = null;
    };
  }, [file.node_id, file.file_id, key]);
  return [state?.key === key ? state.size : null, (size) => { setState({ key, size }); }];
}
