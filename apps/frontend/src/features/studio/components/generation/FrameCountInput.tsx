import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { t } from "@/i18n";
import type { frameLimits } from "../../model/studioGenerationBinding";

interface Props {
  initial: number | null;
  limits: ReturnType<typeof frameLimits>;
  onApply: (frames: number) => void;
  id?: string;
}

export function FrameCountInput({ initial, limits, onApply, id }: Props) {
  const [draft, setDraft] = useState(initial === null ? "" : String(initial));
  const frames = Number(draft);
  const valid = /^\d+$/u.test(draft) && limits.allows(frames);
  const apply = () => { if (valid) onApply(frames); };
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Input id={id} compact type="number" step={1} min={limits.min} max={limits.max} aria-label={t("影格數")}
          className="min-w-0 flex-1" value={draft} onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} />
        <Button type="button" size="sm" disabled={!valid} onClick={apply}>{t("套用")}</Button>
      </div>
      <span className="text-caption text-fg-tertiary">{t("可用範圍：{min}–{max} 影格", { min: limits.min, max: limits.max })}</span>
    </div>
  );
}
