import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { formatTimestamp, shortId } from "@/lib/format";
import { t } from "@/i18n";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && "clipboard" in navigator) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 改用下方的選取複製
  }
  // 內網 HTTP（非 secure context）沒有 clipboard API：以暫時 textarea 選取後複製。
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** 複製完整值；結果以 aria-live 告知，不搶焦點。圖示換成勾號（與換回）時短暫淡入。 */
export function CopyButton({ value, label = t("複製") }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const iconFade = useChangeFade<HTMLSpanElement>(state === "copied");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => {
        void writeClipboard(value).then((ok) => setState(ok ? "copied" : "failed"));
      }}
      className="pressable inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-fg active:bg-sunken"
      aria-label={label}
      title={label}
    >
      <span ref={iconFade} className="inline-flex">
        {state === "copied" ? <Check aria-hidden className="size-3.5 text-success" /> : <Copy aria-hidden className="size-3.5" />}
      </span>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? t("已複製") : state === "failed" ? t("複製失敗，請手動選取") : ""}
      </span>
    </button>
  );
}

/** ID／雜湊：縮寫顯示，完整值可複製並保留在 title。 */
export function IdText({ value, length = 8, className, copy = true }: { value: string | null | undefined; length?: number; className?: string; copy?: boolean }) {
  if (!value) return <span className="text-fg-tertiary">—</span>;
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-0.5 align-middle", className)}>
      <code className="machine truncate text-fg-secondary" title={value}>
        {shortId(value, length)}
      </code>
      {copy ? <CopyButton value={value} label={t("複製完整值 {value}", { value })} /> : null}
    </span>
  );
}

export function TimeText({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return <span className="text-fg-tertiary">—</span>;
  return (
    <time dateTime={iso} title={t("{iso}（UTC）", { iso })} className={cn("machine whitespace-nowrap text-fg-secondary", className)}>
      {formatTimestamp(iso)}
    </time>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("machine text-fg-secondary", className)}>{children}</code>;
}
