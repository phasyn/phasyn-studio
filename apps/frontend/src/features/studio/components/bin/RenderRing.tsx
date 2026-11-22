// The small ring of a shot that is being rendered: the measured share of the DiT's denoising when there is step
// evidence (CircularProgress, moving linearly); a turning ring while nothing is measured yet (rendering, never shown as
// 0 %); a still dashed ring while the shot waits for its turn in the run.
import { CircularProgress } from "@/components/common/CircularProgress";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export function RenderRing({ fraction, waiting = false, size = 20, className }: { fraction: number | null; waiting?: boolean; size?: number; className?: string }) {
  if (fraction !== null) return <CircularProgress value={fraction} size={size} label={t("DiT 去噪進度")} {...(className === undefined ? {} : { className })} />;
  return (
    <span role="progressbar" aria-label={waiting ? t("排隊中") : t("渲染中")} className={cn("inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden focusable="false" className={waiting ? undefined : "animate-spin"}>
        <circle cx="12" cy="12" r="9.25" fill="none" strokeWidth={2.5} strokeDasharray={waiting ? "3 3" : undefined} className="stroke-line-strong" />
        {waiting ? null : <circle cx="12" cy="12" r="9.25" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="14 58" className="stroke-brand-cyan" />}
      </svg>
    </span>
  );
}
