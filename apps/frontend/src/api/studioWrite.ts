import { t } from "@/i18n";
import { isRecord } from "@/lib/json";
import { wireDefinitions } from "@/lib/contractSchemas";
import { ApiError, asErrorBody, contractJson, matchesReply, type ReplyName, type ControllerReplies, type HttpMethod, type RequestOptions } from "./http";

import type { StudioWriteReceipt } from "./generated/contracts";

// Keep only one opaque token per unresolved operation path in this tab. Reloads can read it
// without putting project bodies, prompts or assets into browser storage.
const outstanding = new Map<string, string>();

function prior(slot: string): string | null {
  try { return sessionStorage.getItem(slot) ?? outstanding.get(slot) ?? null; }
  catch { return outstanding.get(slot) ?? null; }
}

function remember(slot: string, key: string | null): void {
  if ((key != null && key !== "")) outstanding.set(slot, key);
  else outstanding.delete(slot);
  try {
    if ((key != null && key !== "")) sessionStorage.setItem(slot, key);
    else sessionStorage.removeItem(slot);
  } catch { /* The in-memory reservation still protects this page when storage is unavailable. */ }
}

function forget(slot: string, key: string): void {
  // Another caller may already have settled this token and started a subsequent write.
  if (prior(slot) === key) remember(slot, null);
}

async function settled<K extends ReplyName>(name: K, project: string, slot: string, key: string, method: HttpMethod, sameCall: boolean): Promise<ControllerReplies[K]> {
  const uri = `/api/studio/projects/${encodeURIComponent(project)}/write-receipts/${key}`;
  let receipt: StudioWriteReceipt | null = null;
  try { receipt = await contractJson("StudioWriteReceipt", uri); } catch { /* Keep the original reservation. */ }
  if (receipt?.state === "committed" && matchesReply(receipt.result, name, await wireDefinitions())) {
    forget(slot, key);
    if (!sameCall || (receipt.project_revision !== null && receipt.current_project_revision !== receipt.project_revision)) {
      // A separate call can contain new edits. Require the native conflict/reload flow before
      // accepting them; returning the previous call's historical document would lose those edits.
      throw new ApiError(409, {
        code: "REVISION_CONFLICT", message: t("請重新讀取已確認寫入的專案版本，再繼續編輯。"),
        details: { receipt: key, saved_revision: receipt.project_revision, stored_revision: receipt.current_project_revision },
      }, "", method);
    }
    return receipt.result;
  }
  if (receipt?.state === "rejected" && isRecord(receipt.result)) {
    forget(slot, key);
    throw new ApiError(receipt.http_status ?? 409, asErrorBody(receipt.result), t("Studio 寫入遭拒"), method);
  }
  if (receipt?.state === "retired") {
    forget(slot, key);
    throw new ApiError(409, { code: "STATE_CONFLICT", details: { receipt: key } }, t("此收據所屬專案已刪除"), method);
  }
  throw new ApiError(0, {
    code: "REMOTE_OUTCOME_UNKNOWN", remote_outcome_unknown: true, details: { receipt: key, receipt_path: uri },
  }, t("Studio 寫入結果尚待核對，收據 {key}", { key }), method);
}

/** Submit a mutation once. Recheck a lost reply, including after page reload or another save attempt. */
export async function studioWrite<K extends ReplyName>(name: K, project: string, path: string, options: RequestOptions): Promise<ControllerReplies[K]> {
  const method = options.method ?? "PUT";
  const slot = `phasyn.studio.write.${method}.${path}`;
  const previous = prior(slot);
  if ((previous != null && previous !== "")) return settled(name, project, slot, previous, method, false);
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  remember(slot, key);
  try {
    const result = await contractJson(name, path, { ...options, headers: { ...options.headers, "Idempotency-Key": key } });
    forget(slot, key);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status > 0 && error.status < 500 && !error.remoteOutcomeUnknown) {
      forget(slot, key);
      throw error;
    }
    if (!(error instanceof ApiError || error instanceof TypeError)) throw error;
    return settled(name, project, slot, key, method, true);
  }
}
