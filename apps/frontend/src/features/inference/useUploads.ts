// 上傳到主控（POST /api/files，uploadFile）：一次一個檔，逐一回報；失敗的檔列出原因，成功的保留。
// 寫入不自動重送：失敗後由使用者重新選檔。onUploaded 在欄位卸載後仍會呼叫（寫進頁面層的草稿 store，
// 切換元件組合時上傳中的檔不會遺失）；只有欄位自己的進度狀態在卸載後停止更新。
// 整批上傳期間在草稿 store 記一筆「上傳中」（依元件組合），完成前不能建立 run。
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadFile } from "@/api/files";
import type { FileRef } from "@/api/generated/contracts";
import { beginUpload } from "./draftStore";

export interface UploadProgress {
  /** 目前第幾個（1 起算）。 */
  index: number;
  total: number;
  name: string;
  size: number;
}

export interface UploadFailure {
  name: string;
  error: unknown;
}

export function useUploads(pipelineId: string) {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [failures, setFailures] = useState<UploadFailure[]>([]);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const upload = useCallback(async (files: readonly File[], onUploaded: (file: File, ref: FileRef) => void) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    const end = beginUpload(pipelineId);
    setFailures([]);
    const failed: UploadFailure[] = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        if (mounted.current) setProgress({ index: index + 1, total: files.length, name: file.name, size: file.size });
        try {
          const ref = await uploadFile(file);
          onUploaded(file, ref);
        } catch (error) {
          failed.push({ name: file.name, error });
        }
      }
    } finally {
      busy.current = false;
      end();
      if (mounted.current) {
        setProgress(null);
        setFailures(failed);
      }
    }
  }, [pipelineId]);

  const clearFailures = useCallback(() => setFailures([]), []);

  return { progress, failures, upload, clearFailures };
}
