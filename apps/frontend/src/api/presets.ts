// Preset：普通 JSON 設定範本；套用只是複製到草稿並顯示差異，不是資格證書。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Preset, PresetList } from "./generated/contracts";
import { apiJson, isApiError } from "./http";
import { qk } from "./keys";

export function usePresets(enabled = true) {
  return useQuery({
    queryKey: qk.presets(),
    queryFn: ({ signal }) => apiJson<PresetList>("/api/presets", { signal }),
    enabled,
    staleTime: 5000,
  });
}

export function useSavePreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (preset: Preset) => apiJson<Preset>(`/api/presets/${encodeURIComponent(preset.preset_id)}`, { method: "PUT", json: preset }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.presets() });
    },
  });
}

export interface DeletedPreset {
  preset_id: string;
  deleted: true;
}

/**
 * DELETE /api/presets/{id}: removes only the preset file (settings it was applied to stay as they are). Sent once. A
 * 404 NOT_FOUND means the preset is already gone (for example deleted in another tab): that is what was asked for, so
 * it counts as deleted. The preset list is read again afterwards.
 */
export function useDeletePreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (presetId: string): Promise<DeletedPreset> => {
      try {
        return await apiJson<DeletedPreset>(`/api/presets/${encodeURIComponent(presetId)}`, { method: "DELETE" });
      } catch (error) {
        if (isApiError(error) && error.status === 404 && error.code === "NOT_FOUND") return { preset_id: presetId, deleted: true };
        throw error;
      }
    },
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.presets() });
    },
  });
}
