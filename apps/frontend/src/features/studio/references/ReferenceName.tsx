// 參考素材的檔名，可就地重新命名（改的是專案素材庫的名稱，所有用到這個檔案的鏡頭一起變）：雙擊名稱、在這一列按 F2，
// 或從列的「…」選單開始；Enter 儲存、Esc 取消、離開欄位時名稱合規就儲存，否則還原。欄位關掉後焦點交給呼叫端（onFinished）。
// 欄位開著時帶 data-escape-local，Esc 只關閉欄位、不關閉外層的專業編輯器。
import { useId, useRef, useState } from "react";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { LIBRARY_NAME_MAX } from "../model/library";
import { t } from "@/i18n";

export interface ReferenceNameProps {
  /** 素材庫名稱；檔案已不在素材庫時為 null（不能改名）。 */
  name: string | null;
  /** 這個參考的 @ 名稱（無障礙名稱用）。 */
  alias: string;
  /** 沒提供＝唯讀。problem：新名稱的問題（空白、太長、和素材庫其他檔案同名），可以用＝null。 */
  rename?: { problem: (name: string) => string | null; onRename: (name: string) => void };
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Enter 或 Esc 關掉欄位之後（欄位離開頁面）：焦點要去的地方。 */
  onFinished?: () => void;
  disabled?: boolean;
}

export function ReferenceName({ name, alias, rename, editing, onEditingChange, onFinished, disabled = false }: ReferenceNameProps) {
  const id = useId();
  const [draft, setDraft] = useState(name ?? "");
  // Enter／Esc 已經結束編輯：欄位卸載時的 blur 不再儲存一次（Esc 不能被 blur 存回去）
  const settled = useRef(false);
  const canRename = rename !== undefined && name !== null && !disabled;
  const problem = rename?.problem(draft) ?? null;

  if (name === null) return <p className="truncate text-data text-warning">{t("檔案已不在專案素材庫")}</p>;

  const start = () => {
    if (!canRename) return;
    setDraft(name);
    settled.current = false;
    onEditingChange(true);
  };
  const finish = (save: boolean) => {
    settled.current = true;
    if (save && !problem && draft.trim() !== name) rename?.onRename(draft.trim());
    onEditingChange(false);
    requestAnimationFrame(() => onFinished?.());
  };

  if (editing && canRename) {
    return (
      <span className="grid min-w-0 gap-0.5 animate-reveal">
        <Input
          compact
          autoFocus
          value={draft}
          aria-label={t("@{alias} 的檔名", { alias })}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-hint`}
          data-escape-local="true"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (settled.current) return;
            settled.current = true;
            if (!problem && draft.trim() !== name) rename?.onRename(draft.trim());
            onEditingChange(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (!problem) finish(true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finish(false);
            }
          }}
          className="min-h-7 px-2"
        />
        <span id={`${id}-hint`} className={cn("text-caption", problem ? "text-danger" : "text-fg-tertiary")}>
          {problem ?? t("Enter 儲存、Esc 取消 · {count}/{max} · 所有鏡頭共用這個檔名", { count: draft.trim().length, max: LIBRARY_NAME_MAX })}
        </span>
      </span>
    );
  }

  return (
    <span className="block truncate text-data text-fg" title={canRename ? t("{name}（雙擊或按 F2 重新命名）", { name }) : name} onDoubleClick={start}>
      {name}
    </span>
  );
}
