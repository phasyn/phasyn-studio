// 檔案：上傳（octet-stream，media_type 由 query 指定）、以 /api/media 讀 JSON 或播放。
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FileRef } from "./generated/contracts";
import { apiFetch, contractJson, mediaUrl } from "./http";
import { qk } from "./keys";

export function uploadBlob(body: Blob, mediaType: string, signal?: AbortSignal): Promise<FileRef> {
  return contractJson("FileRef", "/api/files", {
    method: "POST",
    query: { media_type: mediaType },
    body,
    headers: { "Content-Type": "application/octet-stream" },
    signal,
  });
}

export function uploadFile(file: File, signal?: AbortSignal): Promise<FileRef> {
  return uploadBlob(file, file.type || "application/octet-stream", signal);
}

/** 本機編輯後的 JSON（例如另存新 Scene）上傳成新檔；原檔不變。 */
export function uploadJson(value: unknown, signal?: AbortSignal): Promise<FileRef> {
  const blob = new Blob([JSON.stringify(value)], { type: "application/json" });
  return uploadBlob(blob, "application/json", signal);
}

export function useUploadFile() {
  return useMutation({ mutationFn: (file: File) => uploadFile(file) });
}

export async function fetchFileJson(ref: Pick<FileRef, "node_id" | "file_id">, signal?: AbortSignal): Promise<unknown> {
  const response = await apiFetch(mediaUrl(ref.node_id, ref.file_id), { signal });
  return (await response.json()) as unknown;
}

/** FileRef 指向的 JSON（Scene、manifest）。檔案內容不變，可長期快取。 */
export function useFileJson(ref: Pick<FileRef, "node_id" | "file_id"> | null) {
  return useQuery({
    queryKey: qk.fileJson(ref?.node_id ?? "", ref?.file_id ?? ""),
    queryFn: ({ signal }) => fetchFileJson(ref ?? { node_id: "", file_id: "" }, signal),
    enabled: ref !== null,
    staleTime: Infinity,
    retry: false,
  });
}
