import { useQueries } from "@tanstack/react-query";
import type { StudioLibraryItem, StudioPrevis } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { t } from "@/i18n";

export function useLayerImages(scene: StudioPrevis, library: StudioLibraryItem[]) {
  const ids = Array.from(new Set(scene.layers.flatMap((l) => (l.kind === "image" && (l.item_id != null && l.item_id !== "") ? [l.item_id] : []))));
  const items = ids.map((id) => library.find((item) => item.item_id === id && item.kind === "image"));
  const queries = useQueries({
    queries: items.map((item, index) => ({
      queryKey: ["previs-image", item?.file.node_id, item?.file.file_id, item?.file.sha256, ids[index]],
      enabled: Boolean(item),
      queryFn: async () => {
        if (!item) throw new Error(t("找不到預演使用的素材圖。"));
        const img = new Image();
        img.src = mediaUrl(item.file.node_id, item.file.file_id);
        await img.decode();
        return img;
      },
      staleTime: Infinity,
      gcTime: 60000,
      retry: false,
    })),
  });
  const images = new Map<string, HTMLImageElement>();
  let problem: string | null = null;
  for (const [i, id] of ids.entries()) {
    const q = queries[i];
    if (!items[i]) problem = t("找不到預演使用的素材圖。");
    else if ((q?.isError === true)) problem = t("無法解碼「{name}」的圖片。", { name: items[i].name });
    else if (q?.data) images.set(id, q.data);
  }
  return { images, problem, loading: images.size < ids.length && problem === null };
}
