// take 上記錄「實際送出」的參考素材（StudioTakeReference）：與 materialsFor 共用 orderedReferences 的送出順序
// （圖片 → 聲音 → 影片，各自依 alias 序號）；只列素材庫裡找得到檔案的參考（找不到的會先被 validateReferences 擋下）。
// 終點之後凍結最後一格（hold_last_frame）只在打開時記錄，也算參考的一部分：切換它會讓 take 變成設定已改。
import type { StudioLibraryItem, StudioReference, StudioTake, StudioTakeReference } from "@/api/generated/contracts";
import { heldReference, orderedReferences } from "../references";

export function takeReferences(references: readonly StudioReference[], library: readonly StudioLibraryItem[]): StudioTakeReference[] {
  const items = new Map(library.map((item) => [item.item_id, item]));
  return orderedReferences(references)
    .flatMap((ref) => {
      const item = items.get(ref.item_id);
      if (!item) return [];
      const sent: StudioTakeReference = { alias: ref.alias, kind: ref.kind, file: item.file, start_seconds: ref.start_seconds, end_seconds: ref.end_seconds };
      if (heldReference(ref)) sent.hold_last_frame = true;
      return [sent];
    });
}

const key = (ref: StudioTakeReference) => [ref.alias, ref.kind, ref.file.node_id, ref.file.file_id, ref.start_seconds ?? "", ref.end_seconds ?? "", ref.hold_last_frame === true ? "hold" : ""].join("|");

/** ref2va take 送出的參考與鏡頭目前的參考是否相同（alias、檔案、裁切範圍、終點之後是否凍結）。 */
export function sameTakeReferences(take: Pick<StudioTake, "references">, current: readonly StudioTakeReference[]): boolean {
  const sent = take.references ?? [];
  return sent.length === current.length && sent.every((ref, index) => {
    const other = current[index];
    return other !== undefined && key(ref) === key(other);
  });
}
