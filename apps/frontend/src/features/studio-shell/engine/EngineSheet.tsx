// The engine side sheet of both Studios: header (title, reload when the pipelines or catalog could not be read), the
// Studio's description and route sections, and links to the admin pages. Open state lives in the shell context.
import { useQueryClient } from "@tanstack/react-query";
import { Cpu, ExternalLink, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { qk } from "@/api/keys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle, SheetContent } from "@/components/ui/dialog";
import { useStudioShell } from "../StudioShellContext";
import { t } from "@/i18n";

export interface EngineSheetProps {
  title: string;
  description: ReactNode;
  /** The pipelines or the catalog failed to load: offer to read them again. */
  loadFailed: boolean;
  children: ReactNode;
  /** A strip under the header (for example tabs); the body below it scrolls. */
  toolbar?: ReactNode;
  /** Wider sheet (Video Studio, which also holds the shot's generation settings). */
  wide?: boolean;
}

const DESCRIPTION_ID = "studio-engine-description";

export function EngineSheet({ title, description, loadFailed, children, toolbar, wide = false }: EngineSheetProps) {
  const { engineOpen, setEngineOpen } = useStudioShell();
  const client = useQueryClient();
  const [reloading, setReloading] = useState(false);
  const close = () => setEngineOpen(false);
  return (
    <Dialog open={engineOpen} onOpenChange={setEngineOpen}>
      <SheetContent aria-describedby={DESCRIPTION_ID} className={wide ? "w-[min(40rem,96vw)]" : "w-[min(32rem,94vw)]"}>
        <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3 pr-14">
          <span aria-hidden className="grid size-7 place-items-center rounded-md bg-brand-gradient-soft text-brand-cyan ring-1 ring-brand-blue/40 ring-inset">
            <Cpu className="size-4" />
          </span>
          <DialogTitle className="text-section font-semibold text-fg">{title}</DialogTitle>
          {loadFailed ? (
            <Button
              size="sm"
              variant="quiet"
              icon={<RefreshCw aria-hidden />}
              className="ml-auto"
              pending={reloading}
              onClick={() => {
                if (reloading) return;
                setReloading(true);
                void Promise.all([client.invalidateQueries({ queryKey: qk.pipelines() }), client.invalidateQueries({ queryKey: qk.catalog() })]).finally(() => setReloading(false));
              }}
            >
              {t("重新讀取")}
            </Button>
          ) : null}
        </div>
        {toolbar}
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 py-3">
          <p id={DESCRIPTION_ID} className="text-caption text-fg-tertiary">
            {description}
          </p>
          {children}
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-caption">
            <Link to="/admin/pipelines" onClick={close} className="inline-flex items-center gap-1">
              <ExternalLink aria-hidden className="size-3.5" />
              {t("在「元件修改・元件組合」編輯元件組合")}
            </Link>
            <Link to="/admin/components" onClick={close} className="inline-flex items-center gap-1">
              <ExternalLink aria-hidden className="size-3.5" />
              {t("查看元件的完整設定與精度")}
            </Link>
          </p>
        </div>
      </SheetContent>
    </Dialog>
  );
}
