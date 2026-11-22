import { stringifyJson } from "@/lib/json";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { downloadJson } from "@/lib/download";
import { CopyButton } from "./values";
import { t } from "@/i18n";

/** JSON 以純文字呈現（不解析為 HTML），在自身範圍內捲動。 */
export function JsonView({
  value,
  label,
  fileName,
  className,
  maxHeightClass = "max-h-80",
}: {
  value: unknown;
  label: string;
  fileName?: string;
  className?: string;
  maxHeightClass?: string;
}) {
  const text = stringifyJson(value, 2) ?? "undefined";
  return (
    <div className={cn("min-w-0 rounded-md border border-line-subtle bg-sunken", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-3 py-1">
        <span className="text-caption text-fg-tertiary">{label}</span>
        <span className="flex items-center gap-1">
          <CopyButton value={text} label={t("複製 {label} JSON", { label })} />
          {(fileName != null && fileName !== "") ? (
            <Button size="sm" variant="quiet" icon={<Download aria-hidden />} onClick={() => { downloadJson(fileName, value); }}>
              {t("下載")}
            </Button>
          ) : null}
        </span>
      </div>
      <pre
         /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- Keyboard users can focus this scrollable region and scroll its overflow. */ tabIndex={0}
        aria-label={label}
        className={cn("overflow-auto px-3 py-2 font-mono text-caption leading-5 whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]", maxHeightClass)}
      >
        {text}
      </pre>
    </div>
  );
}
