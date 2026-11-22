// 參考素材上傳（在 studio-shell 的上傳佇列上）：在瀏覽器讀媒體資訊（讀不到＝null）→ uploadFile（主控保存，FileRef 各 Node
// 都能取用）→ 加進專案素材庫，需要時同時加到這個鏡頭（下一個可用的 @ 名稱）、換掉這個鏡頭的一個參考，或交給要選它的地方
// （多個鏡頭一起換參考檔案）。一次處理一個檔案；失敗不自動重送，由使用者按「重新上傳」（會產生新的檔案）。
// 每個上傳記住開始時的專案與鏡頭：換專案或元件卸載時中止進行中的上傳；上傳期間換了鏡頭，檔案仍加進同一個專案的素材庫，
// 但不會被加到另一個鏡頭。
import { useLayoutEffect, useRef } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { uploadFile } from "@/api/files";
import { UploadProblem, useUploadQueue, type UploadRequest, type UploadRun } from "@/features/studio-shell";
import { newLocalId } from "./ids";
import { addBlockedReason, KIND_LABEL, newReference, replacedReference, type ReferenceKind } from "./materials";
import { kindForFile, libraryName, readMediaFacts } from "./media";
import { t } from "@/i18n";

/** 契約：專案素材庫最多 500 個檔案。 */
export const LIBRARY_LIMIT = 500;

/** 一筆上傳的類型（不支援的檔案是 null）。 */
export interface ReferenceUploadInfo {
  kind: ReferenceKind | null;
  /** What the upload is for, as addAndPick's caller named it (other uploads have none). */
  target?: string;
}

export interface UploadScope {
  projectId: string;
  /** 目前的鏡頭（沒提供時只用專案區分）。 */
  shotId: string | null;
  library: readonly StudioLibraryItem[];
  references: readonly StudioReference[];
  onLibraryChange: (next: StudioLibraryItem[]) => void;
  onReferencesChange: (next: StudioReference[]) => void;
}

/** What happens once the file is in the library: nothing more, added to the shot, replacing one of its references, or handed to `pick` (its answer is the message shown). */
type Attach = boolean | { replace: string } | { pick: (item: StudioLibraryItem) => string };

const aborted = () => new DOMException("aborted", "AbortError");

export function useReferenceUploads(current: UploadScope) {
  const queue = useUploadQueue<ReferenceUploadInfo>(current.projectId);
  const latestRef = useRef<UploadScope>(current);

  // 非同步上傳完成時要接在「最新的」素材庫與參考後面（不能用開始上傳時的舊陣列）
  useLayoutEffect(() => {
    latestRef.current = current;
  });

  const upload =
    (file: File, kind: ReferenceKind, attach: Attach, projectId: string, shotId: string | null): UploadRun =>
    async (signal, phase) => {
      // 換了專案（中止前的空檔也算）：檔案不加進任何專案
      const stale = () => signal.aborted || latestRef.current.projectId !== projectId;
      if (latestRef.current.library.length >= LIBRARY_LIMIT) throw new UploadProblem(t("專案素材庫最多 {libraryLimit} 個檔案", { libraryLimit: LIBRARY_LIMIT }));
      phase("reading");
      const facts = await readMediaFacts(file, kind);
      if (stale()) throw aborted();
      phase("uploading");
      const ref = await uploadFile(file, signal);
      if (stale()) throw aborted();
      const now = latestRef.current;
      const item: StudioLibraryItem = { item_id: newLocalId("lib"), kind, name: libraryName(file.name), file: ref, created_at: new Date().toISOString(), ...facts };
      const library = [...now.library, item];
      now.onLibraryChange(library);
      latestRef.current = { ...now, library };
      // Library only; whoever asked chooses the new file (no shot is involved)
      if (typeof attach === "object" && "pick" in attach) return attach.pick(item);
      if (attach === false) return t("已加入專案素材庫");
      if (now.shotId !== shotId) return t("已加入專案素材庫；上傳期間切換了鏡頭，沒有加到任何鏡頭");
      if (typeof attach === "object") {
        // Replace: the reference keeps its @ name and order, and now points at the uploaded file (its clip where the file holds it)
        const target = now.references.find((ref) => ref.ref_id === attach.replace);
        if (target?.kind !== kind) return t("已加入專案素材庫；要換掉的參考已經不在這個鏡頭");
        const references = now.references.map((ref) => (ref.ref_id === target.ref_id ? replacedReference(ref, item.item_id, item.duration_seconds ?? null) : ref));
        now.onReferencesChange(references);
        latestRef.current = { ...latestRef.current, references };
        return t("@{alias} 已換成「{name}」", { alias: target.alias, name: item.name });
      }
      const blocked = addBlockedReason(kind, now.references);
      const created = (blocked != null && blocked !== "") ? null : newReference(item, now.references, newLocalId("ref"));
      if (!created) return t("已加入素材庫，但沒有加到這個鏡頭：{value}", { value: blocked ?? t("{kind}的名稱已用完", { kind: KIND_LABEL[kind] }) });
      const references = [...now.references, created];
      now.onReferencesChange(references);
      latestRef.current = { ...latestRef.current, references };
      return t("已加入，prompt 用 @{alias}", { alias: created.alias });
    };

  /** One file for the queue; a file that is no image, video or sound is refused before uploading. */
  const request = (file: File, attach: Attach): UploadRequest<ReferenceUploadInfo> => {
    const { projectId, shotId } = latestRef.current;
    const kind = kindForFile(file);
    return kind ? { file, info: { kind }, run: upload(file, kind, attach, projectId, shotId) } : { file, info: { kind: null }, problem: t("不支援的檔案類型：只接受圖片、影片、聲音") };
  };

  return {
    /** 這個專案的上傳（其他專案的不顯示）。 */
    tasks: queue.tasks,
    /** attach：上傳後也加到目前的鏡頭。 */
    addFiles: (list: readonly File[], attach: boolean) => { queue.add(list.map((file) => request(file, attach))); },
    /** Uploads one file and, when it is done, makes the reference `refId` point at it (same kind only). */
    replaceWith: (file: File, refId: string) => { queue.add([request(file, { replace: refId })]); },
    /**
     * Uploads one file of `kind` into the library only and, once it is there, hands the new item to `pick` (its answer
     * is the message shown when done). `target` names what it is for (the task's info carries it). A file of another
     * kind is refused before uploading; the answer says whether the file was accepted.
     */
    addAndPick: (file: File, kind: ReferenceKind, target: string, pick: (item: StudioLibraryItem) => string): boolean => {
      const { projectId, shotId } = latestRef.current;
      const fileKind = kindForFile(file);
      const accepted = fileKind === kind;
      queue.add([
        accepted
          ? { file, info: { kind, target }, run: upload(file, kind, { pick }, projectId, shotId) }
          : { file, info: { kind: fileKind, target }, problem: t("只接受{kind}檔案", { kind: KIND_LABEL[kind] }) },
      ]);
      return accepted;
    },
    /** 失敗後由使用者決定重新上傳（新的請求，會產生新的檔案）。 */
    retry: queue.retry,
    dismiss: queue.dismiss,
  };
}
