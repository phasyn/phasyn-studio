import { t } from "@/i18n";

type Fields = Record<string, string | undefined>;
export interface FieldRow { id: string; key: string; value: string }
export const rowsOf = (fields: Fields = {}): FieldRow[] =>
  Object.entries(fields).map(([key, value]) => ({ id: crypto.randomUUID(), key, value: value ?? "" }));
export function fieldsOf(rows: FieldRow[]): Record<string, string> {
  const keys = rows.map((r) => r.key.trim());
  if (
    new Set(keys).size !== keys.length ||
    keys.some((k) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(k)) ||
    rows.some((r) => !r.value.trim())
  ) {
    throw new Error(t("欄位代號需為不重複的英數識別字，並填寫內容。"));
  }
  return Object.fromEntries(rows.map((r) => [r.key.trim(), r.value]));
}
