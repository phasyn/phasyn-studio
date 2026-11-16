// 編輯器的結構性改動（格式化、插入範本、刪除區塊…）一律留下「已做什麼＋復原」的提示；
// 只有內容仍是改動後的樣子才能復原（之後又打字就不覆蓋使用者的新內容）。
import { useState } from "react";
import { PROMPT_MAX_LENGTH } from "./compile";
import { t } from "@/i18n";

export interface ChangeEntry {
  message: string;
  before: string;
  after: string;
}

export interface ChangeNoticeState {
  entry: ChangeEntry | null;
  error: string | null;
  canUndo: boolean;
  /** 套用整份新文字並留下提示；超過字數上限時不套用並顯示原因。 */
  apply: (next: string, message: string) => boolean;
  undo: () => void;
  report: (error: string) => void;
  dismiss: () => void;
}

export function useChangeNotice(value: string, onChange: (next: string) => void): ChangeNoticeState {
  const [entry, setEntry] = useState<ChangeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canUndo = entry !== null && entry.after === value;
  return {
    entry,
    error,
    canUndo,
    apply: (next, message) => {
      if (next.length > PROMPT_MAX_LENGTH) {
        setError(t("結果有 {nextCount} 字元，超過 {promptMaxLength} 字元上限，沒有套用", { nextCount: next.length.toLocaleString("en-US"), promptMaxLength: PROMPT_MAX_LENGTH.toLocaleString("en-US") }));
        return false;
      }
      setError(null);
      if (next !== value) {
        setEntry({ message, before: value, after: next });
        onChange(next);
      }
      return true;
    },
    undo: () => {
      if (!entry || entry.after !== value) return;
      onChange(entry.before);
      setEntry(null);
    },
    report: (message) => setError(message),
    dismiss: () => {
      setEntry(null);
      setError(null);
    },
  };
}
