import { FileUp, LoaderCircle } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * 檔案選擇鈕（原生 file input 藏在可見的按鈕標籤內，鍵盤可聚焦）。不能上傳時不移除焦點（aria-disabled＋擋下開啟），
 * 並顯示原因。選完檔案後清空 input，同一個檔案可以再選一次。
 */
export function UploadButton({
  inputId,
  label,
  accept,
  multiple = false,
  disabledReason,
  pendingText,
  onFiles,
  className,
}: {
  /** 外部需要把焦點移回這個按鈕時使用（例如移除清單最後一項後）。 */
  inputId?: string;
  label: string;
  accept: string;
  multiple?: boolean;
  /** 不能上傳的原因（例如已達上限、上傳中）；null＝可以。 */
  disabledReason?: string | null;
  /** 上傳中顯示在按鈕上的文字。 */
  pendingText?: string | null;
  onFiles: (files: File[]) => void;
  className?: string;
}) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const reasonId = `${id}-reason`;
  const blocked = Boolean(disabledReason) || Boolean(pendingText);
  return (
    <span className={cn("relative inline-flex min-w-0 flex-col gap-1", className)}>
      <label
        htmlFor={id}
        title={disabledReason ?? undefined}
        className={cn(
          "pressable inline-flex min-h-8 w-fit max-w-full cursor-pointer items-center gap-2 rounded-lg border border-line-control bg-raised px-3 text-data text-fg hover:border-fg-tertiary hover:bg-overlay has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus [&_svg]:size-4 [&_svg]:shrink-0",
          blocked && "cursor-not-allowed border-line-subtle text-fg-disabled hover:border-line-subtle hover:bg-raised",
          ((pendingText != null && pendingText !== "") ? "border-brand-blue/40 bg-brand-gradient-soft animate-shimmer" : pendingText),
        )}
      >
        {(pendingText != null && pendingText !== "") ? <LoaderCircle aria-hidden className="text-brand-cyan animate-spin" /> : <FileUp aria-hidden />}
        <span className="truncate" title={pendingText ?? label}>
          {pendingText ?? label}
        </span>
        <input
          id={id}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          aria-disabled={blocked || undefined}
          aria-describedby={(disabledReason != null && disabledReason !== "") ? reasonId : undefined}
          onClick={(event) => {
            if (blocked) event.preventDefault();
          }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0 && !blocked) onFiles(files);
          }}
        />
      </label>
      {(disabledReason != null && disabledReason !== "") ? (
        <span id={reasonId} className="text-caption text-fg-tertiary">
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}
