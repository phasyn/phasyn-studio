// 拖檔案進素材庫時蓋在對話框上的說明：可以放（圖片、影片或聲音）或不收。
import { Ban, Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export function DropOverlay({ verdict }: { verdict: "accept" | "reject" | null }) {
  return (
    <AnimatePresence>
      {verdict ? (
        <motion.div
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motionTransition("fast", "standard")}
          className={cn(
            "pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed backdrop-blur-sm",
            verdict === "accept" ? "border-brand-blue/70 bg-brand-soft" : "border-danger/70 bg-danger/10",
          )}
        >
          <motion.span
            key={verdict}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={motionTransition("spring-snappy", "spring-snappy")}
            className="material-popover grid justify-items-center gap-2 rounded-xl px-6 py-4 text-center"
          >
            {verdict === "accept" ? <Upload aria-hidden className="size-7 text-brand-cyan" /> : <Ban aria-hidden className="size-7 text-danger" />}
            <span className="text-body font-semibold text-fg">{verdict === "accept" ? t("放開以上傳到素材庫") : t("只能上傳圖片、影片或聲音")}</span>
            <span className="text-caption text-fg-tertiary">{verdict === "accept" ? t("圖片、影片或聲音會加進參考素材（不會加到任何鏡頭）；其他檔案會略過") : t("這些檔案不會上傳")}</span>
          </motion.span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
