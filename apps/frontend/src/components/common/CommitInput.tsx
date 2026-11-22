import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export interface CommitInputHandle { commit: () => boolean; focus: () => void }

/**
 * 識別字串輸入（名稱、step_id）：打字時只改本地文字，離開欄位或按 Enter 才提交；
 * 提交被拒絕（例如重名、格式錯誤）時保留文字並顯示原因，不影響其他引用。
 */
export function CommitInput({
  id,
  value,
  onCommit,
  label,
  className,
  disabled,
  placeholder,
  commitRef,
}: {
  id: string;
  value: string;
  /** 回傳錯誤訊息表示拒絕；null 表示已接受。 */
  onCommit: (next: string) => string | null;
  label: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Optional scoped form coordinator; ordinary inputs keep their blur/Enter behavior. */
  commitRef?: Ref<CommitInputHandle>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ base: string; text: string; error: string | null } | null>(null);
  const active = draft?.base === value ? draft : null;
  const text = active ? active.text : value;
  const error = active?.error ?? null;
  const errorId = `${id}-error`;
  const commit = (): boolean => {
    if (disabled === true) return true;
    if (!active || active.text === value) {
      setDraft(null);
      return true;
    }
    const rejection = onCommit(active.text);
    if (rejection != null && rejection !== "") { setDraft({ ...active, error: rejection }); return false; }
    setDraft(null);
    return true;
  };
  useImperativeHandle(commitRef, () => ({ commit, focus: () => inputRef.current?.focus() }));
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <Input
        ref={inputRef}
        id={id}
        aria-label={label}
        className="machine"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={(error != null && error !== "") ? true : undefined}
        aria-describedby={(error != null && error !== "") ? errorId : undefined}
        onChange={(event) => { setDraft({ base: value, text: event.target.value, error: null }); }}
        onBlur={() => { commit(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && active) {
            event.preventDefault();
            setDraft(null);
          }
        }}
      />
      {(error != null && error !== "") ? (
        <p id={errorId} className="text-caption text-danger">
          {t("{error}（按 Esc 還原）", { error })}
        </p>
      ) : null}
    </div>
  );
}
