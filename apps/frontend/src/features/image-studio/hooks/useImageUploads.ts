// 參考圖片上傳（在 studio-shell 的上傳佇列上）：在瀏覽器先檢查格式與大小（與 qimg.prepare 相同的限制：≤ 24 MiB、
// ≤ 2,000 萬像素、最長邊 ≤ 8192），再 uploadFile（主控保存，各 Node 都能取用）→ 加進專案素材庫（source＝upload），需要時
// 同時加成這張圖的參考。一次處理一個檔案；失敗不自動重送，由使用者按「重新上傳」（會產生新的檔案）。換專案或卸載時中止
// 進行中的上傳。
import { useLayoutEffect, useRef } from "react";
import { uploadFile } from "@/api/files";
import { libraryName, newLocalId, readMediaFacts } from "@/features/studio";
import { UploadProblem, useUploadQueue, type UploadRun } from "@/features/studio-shell";
import { importSizeProblem } from "../model/mask";
import type { ImageLibraryItem } from "../types";
import { t } from "@/i18n";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 24 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 上傳前的檢查（格式、檔案大小）；合法時 null。 */
export function uploadProblem(file: { name: string; type: string; size: number }): string | null {
  if (!TYPES.has(file.type)) return t("只接受 PNG、JPEG、WebP 圖片");
  if (file.size > MAX_BYTES) return t("圖片不可超過 24 MiB");
  return null;
}

const aborted = () => new DOMException("aborted", "AbortError");

export function useImageUploads(projectId: string) {
  const queue = useUploadQueue<null>(projectId);
  const currentRef = useRef(projectId);

  useLayoutEffect(() => {
    currentRef.current = projectId;
  });

  const upload =
    (file: File, scope: string, onAdded: (item: ImageLibraryItem) => string | null): UploadRun =>
    async (signal, phase) => {
      // 換了專案（中止前的空檔也算）：檔案不加進任何專案
      const stale = () => signal.aborted || currentRef.current !== scope;
      phase("reading");
      const facts = await readMediaFacts(file, "image");
      if (facts.width === null || facts.height === null) throw new UploadProblem(t("瀏覽器無法解碼這張圖片"));
      const tooBig = importSizeProblem(facts.width, facts.height);
      if (tooBig != null && tooBig !== "") throw new UploadProblem(tooBig);
      if (stale()) throw aborted();
      phase("uploading");
      const ref = await uploadFile(file, signal);
      if (stale()) throw aborted();
      const item: ImageLibraryItem = {
        item_id: newLocalId("lib"),
        kind: "image",
        name: libraryName(file.name),
        file: ref,
        created_at: new Date().toISOString(),
        duration_seconds: null,
        width: facts.width,
        height: facts.height,
        has_audio: false,
        source: { kind: "upload" },
      };
      return onAdded(item) ?? t("已加入專案素材庫");
    };

  return {
    /** 這個專案的上傳（其他專案的不顯示）。 */
    tasks: queue.tasks,
    /** onAdded：上傳完成後（呼叫端把素材寫進專案、需要時加成參考）；回傳要顯示的訊息。 */
    addFiles: (list: readonly File[], onAdded: (item: ImageLibraryItem) => string | null) => {
      const scope = currentRef.current;
      queue.add(
        list.map((file) => {
          const problem = uploadProblem(file);
          return (problem != null && problem !== "") ? { file, info: null, problem } : { file, info: null, run: upload(file, scope, onAdded) };
        }),
      );
    },
    /** 失敗後由使用者決定重新上傳（新的請求，會產生新的檔案）。 */
    retry: queue.retry,
    dismiss: queue.dismiss,
  };
}
