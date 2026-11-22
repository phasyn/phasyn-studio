// 素材或渲染成品的放大預覽（Enter、空白鍵或按兩下）：蓋在素材庫上，←／→ 換上一個／下一個（篩選後的順序），Esc、Enter 或空白鍵關閉。
import { AssetAudio } from "@/components/common/AssetMedia";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { HUD_BUTTON } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { KindIcon } from "../../references/KindIcon";
import { t } from "@/i18n";

/** 要預覽的媒體：key 換了就重新進場；facts＝名稱下方的說明（類型、尺寸…）。 */
export interface PreviewMedia {
  key: string;
  url: string;
  kind: "image" | "video" | "audio";
  name: string;
  facts: readonly string[];
}

export function LibraryPreview({ media, position, total, onStep, onClose }: { media: PreviewMedia; position: number; total: number; onStep: (delta: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { url } = media;
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t("預覽「{name}」", { name: media.name })}
      tabIndex={-1}
      data-library-preview=""
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={motionTransition("base", "standard")}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          onStep(event.key === "ArrowLeft" ? -1 : 1);
        } else if (event.key === "Enter" || (event.key === " " && !(event.target instanceof HTMLMediaElement))) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="absolute inset-0 z-30 grid grid-rows-[minmax(0,1fr)_auto] gap-3 bg-[rgb(2_4_10_/_0.92)] p-6 outline-none backdrop-blur-md"
    >
      <motion.div
        key={media.key}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={motionTransition("spring-smooth", "spring-smooth")}
        className="flex h-full min-h-0 items-center justify-center overflow-hidden"
      >
        {media.kind === "image" ? (
          <img src={url} alt={media.name} draggable={false} className="h-full max-h-full w-full max-w-full rounded-lg object-contain" />
        ) : media.kind === "video" ? (
          <video src={url} controls autoPlay muted playsInline className="h-full max-h-full w-full max-w-full rounded-lg object-contain" />
        ) : (
          <div className="grid w-[min(36rem,100%)] justify-items-center gap-4">
            <KindIcon kind="audio" className="size-16" />
            <AssetAudio src={url} controls autoPlay className="w-full" />
          </div>
        )}
      </motion.div>
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" onClick={() => { onStep(-1); }} disabled={total < 2} aria-label={t("上一個素材")} className={cn(HUD_BUTTON, "size-9")}>
          <ChevronLeft aria-hidden />
        </button>
        <div className="grid min-w-0 flex-1 justify-items-center">
          <p className="max-w-full truncate text-data font-medium text-fg">{media.name}</p>
          <p className="machine text-caption text-fg-tertiary">{joinInline([`${String(position + 1)} / ${String(total)}`, ...media.facts])}</p>
        </div>
        <button type="button" onClick={() => { onStep(1); }} disabled={total < 2} aria-label={t("下一個素材")} className={cn(HUD_BUTTON, "size-9")}>
          <ChevronRight aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label={t("關閉預覽")} title={t("關閉預覽（Esc）")} className={cn(HUD_BUTTON, "size-9")}>
          <X aria-hidden />
        </button>
      </div>
    </motion.div>
  );
}
