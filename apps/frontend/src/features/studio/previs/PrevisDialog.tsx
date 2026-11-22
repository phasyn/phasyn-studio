import { Clapperboard } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { LoadingPanels } from "@/features/studio-shell";
import { t } from "@/i18n";

const PrevisEditor = lazy(() => import("./PrevisEditor"));

export function PrevisDialog({ shot }: { shot: StudioShot }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<Clapperboard aria-hidden />}>
          {t("構圖預演")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl" onKeyDown={(e) => { e.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>
            {t("構圖預演")} · {shot.title}
          </DialogTitle>
          <DialogDescription>{t("選取圖層後可在畫面中拖曳。位置、比例與相機依鏡頭影格插值，輸出使用專案尺寸。")}</DialogDescription>
        </DialogHeader>
        <DialogBody>{open ? <Suspense fallback={<LoadingPanels label={t("構圖預演")} panels={1} />}><PrevisEditor shot={shot} /></Suspense> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
