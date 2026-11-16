// Elapsed time of a run or step. Only this text ticks (once a second, while running), so a page listing many runs does
// not re-render every second.
import { elapsedMs, formatElapsed, useNow } from "@/lib/time";

export function Elapsed({ start, end, running }: { start: string | null | undefined; end: string | null | undefined; running: boolean }) {
  const now = useNow(running);
  return <>{formatElapsed(elapsedMs(start, end, running ? now : null))}</>;
}
