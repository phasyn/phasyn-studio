// run 請求中的 h3.materials.v1（H3 ref2va 參考素材）→ 可讀的列：依「實際送出順序」的 H3 標籤、角色、檔案事實、
// 裁切範圍（參考影片在終點之後凍結最後一格時一併寫出）與影片原聲。標籤用與 Studio／推理頁相同的規則（labelsInOrder），
// 但順序照請求本身（舊 run 可能是別的順序）。FileRef 沒有記錄原始檔名，只顯示 media type、大小與 file_id。純函式。
import type { FileRef } from "@/api/generated/contracts";
import { isFileRef } from "@/api/types";
import { labelsInOrder, ROLE_KIND, ROLE_LABEL, type LabelInput, type MaterialEntry, type OrderedLabel } from "@/lib/h3Materials";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";

export interface MaterialRow {
  /** 送出順序（1 起算）。 */
  position: number;
  role: string;
  /** 已知角色的中文名稱；未知角色＝原文。 */
  roleLabel: string;
  file: FileRef;
  /** H3 TE 看到的標籤；未知角色或編號要 probe 才確定時為 null。 */
  tag: string | null;
  soundtrack: OrderedLabel["soundtrack"];
  /** 裁切範圍（影片／聲音；參考影片終點之後凍結最後一格時含這一句）；圖片為 null。 */
  range: string | null;
}

const KNOWN_ROLES = new Set<string>(Object.keys(ROLE_KIND));

function seconds(value: number): string {
  return String(Number(value.toFixed(3)));
}

function rangeText(start: unknown, end: unknown): string {
  const from = typeof start === "number" && Number.isFinite(start) ? start : null;
  const to = typeof end === "number" && Number.isFinite(end) ? end : null;
  if (from === null && to === null) return t("整段（從頭到結尾）");
  const begin = seconds(from ?? 0);
  // 「到結尾」是完整的一句（不把「結尾」塞進數字的位置：翻譯後會變成 “0–End s”）
  if (to === null) return t("{begin} 秒到結尾", { begin });
  return t("{begin}–{to} 秒", { begin, to: seconds(to) });
}

/** 解析 h3.materials.v1 的值；形狀不符（不是陣列、缺 file 或 role）→ null（呼叫端改顯示原始 JSON）。 */
function known(role: string): role is MaterialEntry["role"] {
  return KNOWN_ROLES.has(role);
}

export function materialRows(value: unknown): MaterialRow[] | null {
  if (!Array.isArray(value)) return null;
  const items: { data: Record<string, unknown>; role: string; file: FileRef }[] = [];
  const labelInputs: LabelInput[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || !isFileRef(item["file"]) || typeof item["role"] !== "string") return null;
    const role = item["role"];
    items.push({ data: item, role, file: item["file"] });
    if (known(role)) {
      const kind = ROLE_KIND[role];
      labelInputs.push(kind === "video" ? { kind, soundtrack: item["use_embedded_audio"] === false ? "off" : "unknown" } : { kind });
    }
  }
  // 有不認得的角色（例如關鍵幀）時，它可能也佔用 <Picture n> 編號：整份都不標標籤，不猜
  const labels = labelInputs.length === items.length ? labelsInOrder(labelInputs) : [];
  return items.map(({ data: item, role, file }, index) => {
    const label = labels[index];
    const range = role === "reference_image" ? null : rangeText(item["start_seconds"], item["end_seconds"]);
    return {
      position: index + 1,
      role,
      roleLabel: known(role) ? ROLE_LABEL[role] : role,
      file,
      tag: label?.label ?? null,
      soundtrack: label?.soundtrack ?? null,
      range: range !== null && role === "reference_video" && item["hold_last_frame"] === true ? t("{range}，之後凍結最後一格", { range }) : range,
    };
  });
}
