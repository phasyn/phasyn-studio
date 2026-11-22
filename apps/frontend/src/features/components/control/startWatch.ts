// 送出 start 之後讀目錄等元件就緒（Studio 渲染引擎、推理頁「需要的元件」共用）。純函式。
// 主控目錄是 Node 推送的快照（狀態改變後 ≥ 200 ms 才更新）：剛送出就讀到的 error／stopped 可能是送出前的舊狀態。
// 只有看到這次的變化（讀到過 loading、錯誤內容改變）或超過寬限時間才下結論；不自動重試。
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { failureText } from "@/lib/errors";

/** 沒看到 loading 也沒看到錯誤內容改變時，error／stopped 維持超過這段時間才當成這次啟動的結果。 */
export const START_GRACE_MS = 10_000;

export interface StartWatch {
  /** 送出 start 前畫面上的 last_error（讀到同一個錯誤可能是舊快照）。 */
  readonly errorBefore: string | null;
  readonly sentAt: number;
  /** 送出後是否讀到過 loading（這次的載入確實開始了）。 */
  readonly sawLoading: boolean;
}

export type StartOutcome =
  | { kind: "wait" }
  | { kind: "ready" }
  | { kind: "failed"; message: string }
  /** unknown：沒看到 loading，只是寬限時間過了仍是 stopped（可能很快就被取消，也可能目錄過時）。 */
  | { kind: "cancelled"; message: string; unknown: boolean };

/** 等待中斷：載入途中回到 stopped（unknown＝沒看到載入，只是寬限時間過了仍是 stopped）。 */
export class StartCancelled extends Error {
  readonly unknown: boolean;

  constructor(message: string, unknown: boolean) {
    super(message);
    this.name = "StartCancelled";
    this.unknown = unknown;
  }
}

function errorKey(error: ComponentDescriptor["last_error"]): string | null {
  return error ? `${error.code}\u0000${error.message}` : null;
}

/** 送出 start（請求已回應）時建立；before＝送出前畫面上的元件描述。 */
export function watchStart(before: Pick<ComponentDescriptor, "last_error">, now: number): StartWatch {
  return { errorBefore: errorKey(before.last_error), sentAt: now, sawLoading: false };
}

/** 讀到一次目錄後的判斷；current＝null：目錄中暫時找不到這個元件（繼續等）。 */
export function observeStart(watch: StartWatch, current: Pick<ComponentDescriptor, "state" | "last_error"> | null, now: number): { watch: StartWatch; outcome: StartOutcome } {
  if (!current) return { watch, outcome: { kind: "wait" } };
  const next = current.state === "loading" && !watch.sawLoading ? { ...watch, sawLoading: true } : watch;
  const late = now - watch.sentAt >= START_GRACE_MS;
  switch (current.state) {
    case "ready":
    case "busy":
      return { watch: next, outcome: { kind: "ready" } };
    case "error": {
      if (!next.sawLoading && !late && errorKey(current.last_error) === watch.errorBefore) return { watch: next, outcome: { kind: "wait" } };
      const message = current.last_error ? failureText(current.last_error.code, current.last_error.message) : t("元件進入錯誤狀態");
      return { watch: next, outcome: { kind: "failed", message } };
    }
    case "stopped":
      if (next.sawLoading) return { watch: next, outcome: { kind: "cancelled", message: t("載入已取消：元件在載入途中回到「已停止」（可能在其他地方按了停止）"), unknown: false } };
      if (late) return { watch: next, outcome: { kind: "cancelled", message: t("送出啟動後目錄一直顯示「已停止」：載入可能已被取消，請查看元件狀態"), unknown: true } };
      return { watch: next, outcome: { kind: "wait" } };
    case "loading":
    case "stopping":
    default:
      return { watch: next, outcome: { kind: "wait" } };
  }
}
