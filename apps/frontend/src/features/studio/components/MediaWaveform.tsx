import { Info } from "lucide-react";
import { t } from "@/i18n";
import { useWaveformPreview, WAVEFORM_BUCKETS } from "../hooks/useMediaPreview";

/** Full-source peaks positioned by the caller's source-to-timeline mapping. */
export function Waveform({ url, fullWidth, offset, height }: { url: string; fullWidth: number; offset: number; height: number }) {
  const { peaks, error } = useWaveformPreview(url);
  if (error && height > 0) return <span className="absolute inset-y-0 left-1 flex items-center text-muted-foreground" title={t("無法載入音訊波形")}><Info aria-hidden size={12} /><span className="sr-only">{t("無法載入音訊波形")}</span></span>;
  if (!peaks || height <= 0) return null;
  const mid = height / 2;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < WAVEFORM_BUCKETS; i += 1) {
    const x = ((i + 0.5) / WAVEFORM_BUCKETS) * fullWidth;
    const amp = Math.max(0.5, (peaks[i] ?? 0) * (mid - 2));
    top.push(`${x.toFixed(1)},${(mid - amp).toFixed(1)}`);
    bottom.push(`${x.toFixed(1)},${(mid + amp).toFixed(1)}`);
  }
  return (
    <svg aria-hidden className="absolute inset-y-0" style={{ left: -offset }} width={fullWidth} height={height} viewBox={`0 0 ${fullWidth} ${height}`} preserveAspectRatio="none">
      <polygon points={[...top, ...bottom.reverse()].join(" ")} className="fill-brand-cyan/70" />
    </svg>
  );
}
