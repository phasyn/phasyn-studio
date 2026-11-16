// A file dragged from the desktop and released outside a drop zone would make the browser open it in place of the
// Studio. Drop zones (the Project panel, the asset library) take the event themselves; whatever they leave is refused
// here, for the whole window.
import { useEffect } from "react";

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

export function useFileDropGuard(): void {
  useEffect(() => {
    const refuse = (event: DragEvent) => {
      if (event.defaultPrevented || !carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);
}
