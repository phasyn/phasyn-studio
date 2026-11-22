// 緊湊的提交式輸入：打字只改本地草稿，Enter 或離開欄位才提交；被拒絕時保留輸入並顯示原因，Esc 還原。
import { useState } from "react";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export function DraftField({
  id,
  value,
  onCommit,
  label,
  placeholder,
  disabled,
  mono = false,
  inputMode,
  className,
}: {
  id: string;
  value: string;
  /** 回傳錯誤訊息表示拒絕；null 表示已接受。 */
  onCommit: (next: string) => string | null;
  /** 無障礙名稱（畫面上的標籤由呼叫端以 <label htmlFor> 提供時也可重複）。 */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  inputMode?: "decimal" | "numeric" | "text";
  className?: string;
}) {
  const [draft, setDraft] = useState<{ base: string; text: string; error: string | null } | null>(null);
  const active = draft?.base === value ? draft : null;
  const errorId = `${id}-error`;
  const commit = () => {
    if (!active || active.text === value) {
      setDraft(null);
      return;
    }
    const rejection = onCommit(active.text);
    setDraft((rejection != null && rejection !== "") ? { ...active, error: rejection } : null);
  };
  return (
    <span className={cn("grid min-w-0 gap-0.5", className)}>
      <Input
        id={id}
        compact
        aria-label={label}
        value={active ? active.text : value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        aria-invalid={(active?.error != null && active.error !== "") ? true : undefined}
        aria-describedby={(active?.error != null && active.error !== "") ? errorId : undefined}
        data-escape-local={active ? "true" : undefined}
        className={cn("min-h-7 px-2", mono && "machine")}
        onChange={(event) => { setDraft({ base: value, text: event.target.value, error: null }); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && active) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {(active?.error != null && active.error !== "") ? (
        <span id={errorId} className="text-caption text-danger">
          {t("{error}（Esc 還原）", { error: active.error })}
        </span>
      ) : null}
    </span>
  );
}
