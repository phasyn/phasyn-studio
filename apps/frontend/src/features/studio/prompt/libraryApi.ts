// 固定 Prompt 片段庫 API（x-phasyn-extension）：GET 讀取（沒存過＝revision 0）、PUT 整份保存。
// PUT 本文 revision 必須等於伺服器目前 revision；409 REVISION_CONFLICT → 重新讀取並告訴使用者，絕不自動重送。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioPromptLibrary } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { hasErrorCode } from "@/lib/errors";

export const promptLibraryKeys = {
  library: () => ["studio", "prompt-library"] as const,
};

const PATH = "/api/studio/prompt-library";

export function fetchPromptLibrary(signal?: AbortSignal): Promise<StudioPromptLibrary> {
  return contractJson("StudioPromptLibrary", PATH, { signal });
}

export function savePromptLibrary(library: StudioPromptLibrary): Promise<StudioPromptLibrary> {
  return contractJson("StudioPromptLibrary", PATH, { method: "PUT", json: library });
}

export function usePromptLibrary(enabled = true) {
  return useQuery({
    queryKey: promptLibraryKeys.library(),
    queryFn: ({ signal }) => fetchPromptLibrary(signal),
    staleTime: 30_000,
    enabled,
  });
}

/** 保存整份片段庫；成功後更新快取。版本衝突時重新讀取（不重送），由呼叫端顯示原因並保留使用者的草稿。 */
export function useSavePromptLibrary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: savePromptLibrary,
    retry: false,
    onSuccess: (saved) => client.setQueryData(promptLibraryKeys.library(), saved),
    onError: (error) => {
      if (hasErrorCode(error, "REVISION_CONFLICT")) void client.invalidateQueries({ queryKey: promptLibraryKeys.library() });
    },
  });
}
