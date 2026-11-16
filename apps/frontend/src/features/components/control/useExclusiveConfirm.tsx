// Confirmation before the Node replaces the loaded members of an exclusive group (see exclusive.ts).
// `confirm` returns a promise the dialog settles; several requests at once are queued and shown one after another.
// Unmounting declines everything still waiting, so no caller is left hanging.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ConfirmReplace } from "./exclusive";
import { ExclusiveConfirmDialog, type PendingConfirm } from "./ExclusiveConfirmDialog";

/** `confirm` for requestStart() plus the dialog element the caller renders once. */
export function useExclusiveConfirm(): { confirm: ConfirmReplace; dialog: ReactNode } {
  const queue = useRef<PendingConfirm[]>([]);
  const [current, setCurrent] = useState<PendingConfirm | null>(null);

  useEffect(
    () => () => {
      const waiting = queue.current;
      queue.current = [];
      for (const item of waiting) item.resolve(false);
    },
    [],
  );

  const confirm = useCallback<ConfirmReplace>(
    (conflict, target) =>
      new Promise<boolean>((resolve) => {
        queue.current = [...queue.current, { conflict, target, resolve }];
        setCurrent(queue.current[0] ?? null);
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    const [head, ...rest] = queue.current;
    queue.current = rest;
    setCurrent(rest[0] ?? null);
    head?.resolve(confirmed);
  }, []);

  return { confirm, dialog: <ExclusiveConfirmDialog request={current} onSettle={settle} /> };
}
