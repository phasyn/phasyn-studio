// Save failure banner of both Studios. Nothing shows while saving works (the chrome carries no save badge); when the
// project could not be stored on the Controller and no save has succeeded for a few seconds (the Controller restarted,
// the network dropped, the document was refused), a line below the toolbar says so with the reason and a retry, and
// confirms the recovery briefly. A version conflict is the conflict banner's.
import { Check, CloudOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { useStudioShell } from "./StudioShellContext";
import { t } from "@/i18n";

/** A failure this short is not worth a banner: the next edit or the retry usually stores the project. */
const SHOW_AFTER_MS = 3000;
const RECOVERED_MS = 2000;

const BANNER = "mx-1.5 mb-1.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-1.5 text-data animate-pop-in";

export function SaveFailureBanner() {
  const { doc, saveNow } = useStudioShell();
  const status = doc.status;
  // "Troubled": a save failed and none has succeeded since (later edits keep failing, a retry is on its way)
  const [troubled, setTroubled] = useState(false);
  const [shown, setShown] = useState(false);
  const [recovered, setRecovered] = useState(false);
  // Derived from the status while rendering (no effect), like the save announcement
  if (status === "error" && !troubled) {
    setTroubled(true);
    setRecovered(false);
  }
  if ((status === "saved" || status === "conflict") && troubled) {
    setTroubled(false);
    setShown(false);
    setRecovered(shown && status === "saved");
  }
  useEffect(() => {
    if (!troubled) return;
    const timer = window.setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [troubled]);
  useEffect(() => {
    if (!recovered) return;
    const timer = window.setTimeout(() => setRecovered(false), RECOVERED_MS);
    return () => window.clearTimeout(timer);
  }, [recovered]);

  if (troubled && shown) {
    return (
      <div role="alert" className={cn(BANNER, "border-danger/40 bg-danger/10 text-danger")}>
        <CloudOff aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {status === "error" ? t("專案沒有存到主控：{reason}", { reason: errorText(doc.error) }) : t("專案還沒有存到主控，正在再試一次…")}
        </span>
        <Button size="sm" variant="secondary" pending={status === "saving"} disabled={status !== "error"} onClick={saveNow}>
          {t("重試")}
        </Button>
      </div>
    );
  }
  if (recovered) {
    return (
      <div role="status" className={cn(BANNER, "border-success/40 bg-success/10 text-success")}>
        <Check aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{t("專案已經存到主控")}</span>
      </div>
    );
  }
  return null;
}
