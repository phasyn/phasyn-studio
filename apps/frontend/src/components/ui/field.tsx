import { hasSlotContent } from "@/lib/dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export interface FieldProps {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  units?: string | null;
  path?: string;
  className?: string;
  children: (describedBy: string | undefined) => ReactNode;
}

/** 標籤、說明、錯誤與輸入元件的關聯（aria-describedby）；錯誤保留使用者輸入。 */
export function Field({ id, label, help, error, hint, units, path, className, children }: FieldProps) {
  const helpId = hasSlotContent(help) ? `${id}-help` : null;
  const errorId = (error != null && error !== "") ? `${id}-error` : null;
  const hintId = hasSlotContent(hint) ? `${id}-hint` : null;
  const describedBy = [errorId, hintId, helpId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid min-w-0 content-start gap-2", className)}>
      <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 text-data font-medium text-fg-secondary">
        <span>{label}</span>
        {(units != null && units !== "") ? <span className="text-caption font-normal text-fg-tertiary">{t("（{units}）", { units })}</span> : null}
        {(path != null && path !== "") ? <code className="text-caption font-normal text-fg-tertiary">{path}</code> : null}
      </label>
      {children(describedBy)}
      {(error != null && error !== "") ? (
        <p id={errorId ?? undefined} className="text-caption text-danger">
          {error}
        </p>
      ) : null}
      {hasSlotContent(hint) ? (
        <p id={hintId ?? undefined} className="text-caption text-warning">
          {hint}
        </p>
      ) : null}
      {hasSlotContent(help) ? (
        <p id={helpId ?? undefined} className="text-caption text-fg-tertiary">
          {help}
        </p>
      ) : null}
    </div>
  );
}
