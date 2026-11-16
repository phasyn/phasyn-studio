// The switch of the end-of-render sound (renderSound.ts) with a preview, in the running render's popover: the place
// people look while they wait, and where they decide whether they want to be told when it ends.
import { Volume2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { t } from "@/i18n";
import { playRenderSound, renderSoundSetting } from "./renderSound";

export function RenderSoundToggle() {
  const id = useId();
  const on = renderSoundSetting.use();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-white/8 px-3">
      <Switch
        id={id}
        label={t("完成時播放音效")}
        checked={on}
        onChange={(event) => renderSoundSetting.set(event.target.checked)}
        className="min-w-0 flex-1 text-caption"
      />
      <Button size="sm" variant="quiet" icon={<Volume2 aria-hidden />} title={t("試聽完成音效")} onClick={() => playRenderSound("done", true)}>
        {t("試聽")}
      </Button>
    </div>
  );
}
