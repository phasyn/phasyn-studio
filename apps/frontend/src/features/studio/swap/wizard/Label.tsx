// Field label with an optional hint line, used by every wizard step.
import type { ReactNode } from "react";

export function Label({ htmlFor, children, hint }: { htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="grid gap-0.5">
      <label htmlFor={htmlFor} className="text-caption font-medium text-fg-secondary">
        {children}
      </label>
      {hint ? <span className="text-caption text-fg-tertiary">{hint}</span> : null}
    </span>
  );
}
