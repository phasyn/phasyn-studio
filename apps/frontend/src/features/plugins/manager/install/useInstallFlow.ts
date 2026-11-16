// 安裝一個插件包的流程：選檔 → 驗證（主控的 dry run：只檢查、不安裝，回報安裝後的內容、會取代的版本與多出的權限）
// → 使用者看過預覽後確認 → 安裝（帶上 dry run 回報的 digest，內容不同主控會拒絕）。每個請求只送一次，從不自動重送；
// 驗證可以取消，安裝送出後不能（寫入的結果只能重新讀取登錄表確認）。
// 檔案在選取時讀進記憶體一次，驗證與安裝送的是同一份位元組：預覽之後檔案在磁碟上被改寫（重新打包）也不影響這次安裝，
// 瀏覽器也不會因為檔案變了而讓上傳失敗（那會被看成連線中斷）。
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioPluginInstallResult } from "@/api/generated/contracts";
import { ApiError } from "@/api/http";
import { installPlugin, packageTooLarge, pluginKeys } from "@/api/plugins";
import { t } from "@/i18n";
import { isAbortError } from "@/lib/async";

interface Picked {
  file: Blob;
  fileName: string;
  size: number;
}

export type InstallState =
  | { phase: "idle" }
  | ({ phase: "checking" } & Picked)
  | ({ phase: "preview"; result: StudioPluginInstallResult } & Picked)
  | ({ phase: "installing"; result: StudioPluginInstallResult } & Picked)
  | { phase: "done"; fileName: string; result: StudioPluginInstallResult }
  /** stage＝在哪一步失敗：check（驗證，什麼都沒安裝）或 install（安裝請求；連線中斷時遠端結果未知）。 */
  | ({ phase: "failed"; stage: "check" | "install"; error: unknown } & Picked);

export interface InstallFlow {
  state: InstallState;
  /** 開始驗證一個檔案（進行中的流程會被取代；安裝請求送出後不接受新的檔案）。 */
  start: (file: File) => void;
  /** 確認安裝預覽中的包。 */
  confirm: () => void;
  /** 取消驗證或放棄預覽；關掉失敗或完成的結果。 */
  dismiss: () => void;
}

const IDLE: InstallState = { phase: "idle" };

/** The file's bytes, read once. A file that cannot be read (moved, no permission) is refused before anything is sent. */
async function readPackage(file: File): Promise<Blob> {
  try {
    return new Blob([await file.arrayBuffer()], { type: "application/octet-stream" });
  } catch {
    // Built like the size refusal in api/plugins.ts: an error of this client, nothing was sent
    throw new ApiError(400, { code: "LOCAL_FILE_UNREADABLE", message: t("讀不到這個檔案；請重新選擇") }, "LOCAL_FILE_UNREADABLE", "POST");
  }
}

export function useInstallFlow({ maxBytes, onInstalled }: { maxBytes: number | null; onInstalled: (result: StudioPluginInstallResult) => void }): InstallFlow {
  const client = useQueryClient();
  const [state, setState] = useState<InstallState>(IDLE);
  const current = useRef<InstallState>(IDLE);
  const checking = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const update = useCallback((next: InstallState) => {
    current.current = next;
    if (mounted.current) setState(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      checking.current?.abort();
    };
  }, []);

  const start = useCallback(
    (file: File) => {
      if (current.current.phase === "installing") return;
      checking.current?.abort();
      const picked: Picked = { file, fileName: file.name, size: file.size };
      const tooLarge = maxBytes === null ? null : packageTooLarge(file, maxBytes);
      if (tooLarge) {
        update({ phase: "failed", stage: "check", error: tooLarge, ...picked });
        return;
      }
      const controller = new AbortController();
      checking.current = controller;
      update({ phase: "checking", ...picked });
      // This check is still the one in progress (not cancelled, not replaced by another file)
      const live = () => checking.current === controller && !controller.signal.aborted;
      readPackage(file)
        .then(async (bytes) => {
          if (!live()) return;
          const held: Picked = { ...picked, file: bytes };
          update({ phase: "checking", ...held });
          const result = await installPlugin(bytes, { dryRun: true, signal: controller.signal });
          if (live()) update({ phase: "preview", result, ...held });
        })
        .catch((error: unknown) => {
          if (live() && !isAbortError(error)) update({ phase: "failed", stage: "check", error, ...picked });
        });
    },
    [maxBytes, update],
  );

  const confirm = useCallback(() => {
    const now = current.current;
    if (now.phase !== "preview") return;
    const { file, fileName, size, result } = now;
    update({ phase: "installing", file, fileName, size, result });
    installPlugin(file, { replace: result.replaces !== null, digest: result.detail.plugin.digest })
      .then(
        (installed) => {
          update({ phase: "done", fileName, result: installed });
          onInstalled(installed);
        },
        (error: unknown) => update({ phase: "failed", stage: "install", error, file, fileName, size }),
      )
      // 不論結果都重新讀取登錄表：連線中斷時，這是唯一能知道有沒有裝上的方法
      .finally(() => void client.invalidateQueries({ queryKey: pluginKeys.all() }));
  }, [client, onInstalled, update]);

  const dismiss = useCallback(() => {
    if (current.current.phase === "installing") return;
    checking.current?.abort();
    checking.current = null;
    update(IDLE);
  }, [update]);

  return { state, start, confirm, dismiss };
}
