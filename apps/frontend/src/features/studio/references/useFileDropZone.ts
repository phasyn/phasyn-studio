// The references tab as one drop target: files dragged over any part of the tab — not only the list — light up the
// whole tab, and dropping them uploads them to the project library and adds them to the shot. The tab is the closest
// tab panel around the references (the inspector's 參考 tab, or the professional prompt editor's); without one, the
// panel itself. The highlight is drawn in the top layer over the tab's box (floating.ts), so it covers the visible tab
// whatever its scroll; it never takes the pointer, the tab below keeps receiving the drag.
import { useEffect, useRef, useState, type RefObject } from "react";
import { floatingFrame, floatingHost, type Frame } from "../components/generation/floating";

export interface DropHighlight {
  host: HTMLElement;
  /** The tab's box in the host's fixed coordinates. */
  box: Frame;
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

export function useFileDropZone(anchor: RefObject<HTMLElement | null>, enabled: boolean, onFiles: (files: File[]) => void): DropHighlight | null {
  const [highlight, setHighlight] = useState<DropHighlight | null>(null);
  const latest = useRef({ enabled, onFiles });
  useEffect(() => {
    latest.current = { enabled, onFiles };
  });

  useEffect(() => {
    const node = anchor.current;
    if (!node) return;
    const zone = node.closest<HTMLElement>('[role="tabpanel"]') ?? node;
    const host = floatingHost(zone);
    const over = (event: DragEvent) => {
      if (!carriesFiles(event) || !latest.current.enabled) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      const frame = floatingFrame(host);
      const rect = zone.getBoundingClientRect();
      const box = { left: rect.left - frame.left, top: rect.top - frame.top, width: rect.width, height: rect.height };
      setHighlight((current) =>
        current && current.box.left === box.left && current.box.top === box.top && current.box.width === box.width && current.box.height === box.height ? current : { host, box },
      );
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && zone.contains(event.relatedTarget)) return;
      setHighlight(null);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      setHighlight(null);
      if (!latest.current.enabled) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) latest.current.onFiles(files);
    };
    zone.addEventListener("dragenter", over);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", over);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
  }, [anchor]);

  return highlight;
}
