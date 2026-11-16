import { useState } from "react";

/**
 * The null switch of a nullable field: switching to null remembers the current value, switching back restores it (or,
 * when there was none, the value `fallback` gives).
 */
export function useNullSwitch(value: unknown, onChange: (next: unknown) => void, fallback: () => unknown): (checked: boolean) => void {
  const [remembered, setRemembered] = useState<unknown>(undefined);
  return (checked) => {
    if (checked) {
      if (value !== null && value !== undefined) setRemembered(value);
      onChange(null);
    } else {
      onChange(remembered !== undefined ? remembered : fallback());
    }
  };
}
