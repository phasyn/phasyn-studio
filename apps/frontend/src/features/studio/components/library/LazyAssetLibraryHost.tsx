// Where the asset library dialog mounts in the Studio toolbar: its code loads apart from the page (assetLibraryLoad)
// once the browser is idle, or at the latest when the library opens. From then on the dialog stays mounted, so it keeps
// its section, filters, selection and scroll position between openings, and its uploads continue while it is closed.
// When the code cannot be loaded, opening the library shows the lazy-part failure (with its reload) in a dialog.
import { useEffect } from "react";
import { LazyBoundary } from "@/components/common/LazyBoundary";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { loadAssetLibrary, useAssetLibraryLoad } from "./assetLibraryLoad";
import { closeAssetLibrary, useAssetLibraryOpen } from "./libraryOpen";
import { t } from "@/i18n";

/** Idle preload: the first opening is then instant, without the dialog's code in the page chunk. */
function usePreloadWhenIdle() {
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(loadAssetLibrary, { timeout: 4000 });
      return () => { window.cancelIdleCallback(handle); };
    }
    const timer = window.setTimeout(loadAssetLibrary, 1500);
    return () => { window.clearTimeout(timer); };
  }, []);
}

/** Rethrows the load failure, so LazyBoundary shows it exactly as for every other lazy part. */
function LoadFailure({ failure }: { failure: unknown }): never {
  throw failure instanceof Error ? failure : new Error("the asset library failed to load");
}

export function LazyAssetLibraryHost() {
  const { open } = useAssetLibraryOpen();
  const { module, failure } = useAssetLibraryLoad();
  usePreloadWhenIdle();
  useEffect(() => {
    if (open) loadAssetLibrary();
  }, [open]);
  if (module) return <module.AssetLibraryHost />;
  if (failure === null) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeAssetLibrary(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("專案素材庫")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <LazyBoundary>
            <LoadFailure failure={failure} />
          </LazyBoundary>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
