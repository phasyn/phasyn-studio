import { Download } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { LoadingPanels } from "@/features/studio-shell";
import { t } from "@/i18n";
import { useEditor } from "../editor/editorContext";

const ExportForm = lazy(() => import("./ExportForm"));

/**
 * The delivery button and its dialog (基本／進階 for the MP4, 剪輯交換, 專案可攜包); `primary` draws the gradient 「匯出」
 * of the Edit workspace's header. size and className size the trigger where it sits (the work list's footer makes it
 * full width).
 */
export function ExportDialog({ primary = false, size = "sm", className }: { primary?: boolean; size?: "sm" | "md"; className?: string }) {
  const { busy } = useEditor();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={primary ? "primary" : "secondary"} icon={<Download aria-hidden />} pending={busy === "export"} title={t("匯出 MP4 影片、交給外部剪輯軟體，或打包整個專案")} className={className}>
          {primary ? t("匯出") : t("匯出序列…")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl" onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("匯出與交付")}</DialogTitle>
          <DialogDescription>{t("把時間軸輸出成影片、交給外部剪輯軟體繼續編輯，或把整個專案打包帶走。")}</DialogDescription>
        </DialogHeader>
        {open ? <Suspense fallback={<LoadingPanels label={t("匯出序列")} panels={1} />}><ExportForm onDone={() => { setOpen(false); }} /></Suspense> : null}
      </DialogContent>
    </Dialog>
  );
}
